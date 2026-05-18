import fs from 'node:fs/promises';
import path from 'node:path';

import type { APIRoute } from 'astro';
import { z } from 'zod';

import {
  AnthropicChatError,
  hasApiKey,
  MissingApiKeyError,
  missingApiKeyMessage,
  sendMessageWithTools,
  type ToolExecutor,
} from '@/lib/chat/anthropic.js';
import {
  appendTurn,
  loadThread,
  serializeTurn,
  type PersistedToolCall,
} from '@/lib/chat/conversation.js';
import { buildSystemPrompt } from '@/lib/chat/system-prompt.js';
import { getChatTools } from '@/lib/chat/tool-schemas.js';
import { executeTool } from '@/lib/chat/tools.js';
import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const MAX_ATTACHMENT_SIZE = 10 * 1024; // 10 KB — inline only short text uploads.
const TEXTUAL_EXTENSIONS = new Set<string>([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.log',
]);

const MessageBody = z.object({
  thread_id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'thread_id must contain only alphanumeric, dot, dash, or underscore'),
  content: z.string().trim().min(1, 'content is required'),
  attachments: z.array(z.string()).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  if (!hasApiKey()) {
    return json(503, { error: missingApiKeyMessage() });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const parsed = MessageBody.safeParse(body);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  const roleHome = getRoleHome();

  let thread;
  try {
    thread = await loadThread(roleHome, parsed.data.thread_id);
  } catch (error: unknown) {
    if (isNotFound(error)) return json(404, { error: 'Thread not found' });
    return json(500, { error: errorMessage(error) });
  }

  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(roleHome);
  } catch (error: unknown) {
    return json(500, { error: `Failed to assemble system prompt: ${errorMessage(error)}` });
  }

  const attachmentBlock = await renderAttachmentsInline(roleHome, parsed.data.attachments ?? []);
  const userContent = attachmentBlock
    ? `${attachmentBlock}\n\n${parsed.data.content}`
    : parsed.data.content;

  // Wire the tool executor. It captures `roleHome` and dispatches via the
  // shared `executeTool` registry — keeps the routing logic in one place.
  const toolExecutor: ToolExecutor = async (name, input) => {
    const result = await executeTool(name, input, roleHome);
    if (result.ok) {
      // The model sees a compact human-readable summary + the structured data
      // payload as JSON. That gives it enough to plan follow-up turns while
      // staying inside the 1024-token budget Anthropic suggests for tool_result.
      const text = [`${result.summary}.`, JSON.stringify(result.data)].join('\n');
      return { ok: true, contentText: text, summary: result.summary, data: result.data };
    }
    return { ok: false, contentText: result.error };
  };

  // Build the tool list per request so MCP catalog freshness doesn't require
  // a dashboard restart; the catalog itself is module-cached and only re-hits
  // unreachable servers past the per-server debounce window.
  const chatTools = await getChatTools(roleHome);

  let assistantText: string;
  let toolCalls: PersistedToolCall[];
  let truncated = false;
  try {
    const result = await sendMessageWithTools(
      systemPrompt,
      thread.turns,
      userContent,
      chatTools,
      toolExecutor,
    );
    assistantText = result.text;
    toolCalls = result.toolCalls;
    truncated = result.truncated;
  } catch (error: unknown) {
    if (error instanceof MissingApiKeyError) {
      return json(503, { error: error.message });
    }
    if (error instanceof AnthropicChatError) {
      return json(502, { error: error.message });
    }
    return json(500, { error: errorMessage(error) });
  }

  if (truncated && assistantText.length === 0) {
    assistantText = '(stopped after the tool-use iteration cap was reached)';
  }

  // Persist the user turn first, then the assistant reply, so a crash between
  // them leaves the file in a coherent "user said X, no reply yet" state.
  try {
    await appendTurn(roleHome, parsed.data.thread_id, {
      role: 'user',
      content: userContent,
    });
    const assistantTurn = await appendTurn(roleHome, parsed.data.thread_id, {
      role: 'assistant',
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    const serialized = serializeTurn(assistantTurn);
    return json(200, {
      role: 'assistant',
      content: assistantText,
      content_html: serialized.content_html,
      timestamp: assistantTurn.timestamp,
      toolCalls,
      truncated,
    });
  } catch (error: unknown) {
    return json(500, {
      error: `Failed to persist turn: ${errorMessage(error)}`,
      reply: assistantText,
    });
  }
};

/**
 * Read uploaded attachments and inline them into the user content when they're
 * small + text-shaped. Larger or non-text attachments are mentioned by path
 * only (the model can ask the operator about them if needed).
 */
async function renderAttachmentsInline(
  roleHome: string,
  attachments: string[],
): Promise<string | null> {
  if (attachments.length === 0) return null;
  const pieces: string[] = [];

  for (const rel of attachments) {
    if (!isSafeAttachmentPath(rel)) {
      pieces.push(`[Attachment refused — unsafe path: ${rel}]`);
      continue;
    }
    const abs = path.join(roleHome, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      pieces.push(`[Attachment missing: ${rel}]`);
      continue;
    }

    const filename = path.basename(rel);
    const ext = path.extname(filename).toLowerCase();
    if (!TEXTUAL_EXTENSIONS.has(ext) || stat.size > MAX_ATTACHMENT_SIZE) {
      pieces.push(`[Attachment: ${filename} — ${stat.size} bytes, not inlined]`);
      continue;
    }
    try {
      const text = await fs.readFile(abs, 'utf-8');
      pieces.push(`--- Attachment: ${filename} ---\n${text}\n--- end attachment ---`);
    } catch {
      pieces.push(`[Attachment unreadable: ${filename}]`);
    }
  }

  return pieces.join('\n\n');
}

function isSafeAttachmentPath(rel: string): boolean {
  if (rel.length === 0) return false;
  if (rel.includes('..')) return false;
  if (path.isAbsolute(rel)) return false;
  // Attachments live under lib/uploads/<thread_id>/ — accept any path that
  // starts with that prefix to keep the surface narrow.
  return rel.startsWith('lib/uploads/');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
