import type { APIRoute } from 'astro';
import { z } from 'zod';

import {
  AnthropicChatError,
  getAttachmentSupport,
  hasApiKey,
  MissingApiKeyError,
  missingApiKeyMessage,
  sendMessageWithTools,
  type ToolExecutor,
} from '@/lib/chat/anthropic.js';
import { buildUserContent } from '@/lib/chat/attachments.js';
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

const MessageBody = z.object({
  thread_id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'thread_id must contain only alphanumeric, dot, dash, or underscore'),
  content: z.string().trim(),
  attachments: z.array(z.string()).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  if (!(await hasApiKey())) {
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

  const attachments = parsed.data.attachments ?? [];
  if (parsed.data.content.length === 0 && attachments.length === 0) {
    return json(422, { error: 'content or attachments required' });
  }
  // When the operator sends attachments without typing anything, give the
  // model a default instruction so it has a turn to act on.
  const effectiveText =
    parsed.data.content.length > 0 ? parsed.data.content : 'Please review the attached file(s).';

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

  // Resolve attachments against the provider's native capability: small text
  // files inline into the prompt, supported images/docs become base64 blocks,
  // and anything the backend can't read becomes a short refusal note.
  const support = await getAttachmentSupport();
  const { content: userContent, persistedText } = await buildUserContent(
    roleHome,
    effectiveText,
    attachments,
    support,
  );

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
      content: persistedText,
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
