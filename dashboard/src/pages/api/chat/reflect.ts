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

const ReflectBody = z.object({
  thread_id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'thread_id must contain only alphanumeric, dot, dash, or underscore'),
});

/**
 * The reflection prompt — the model is invited to use its growth tools to
 * capture anything worth keeping from the conversation. We don't force a
 * tool call: if nothing earned its keep, a short summary is the right
 * response. The phrasing mirrors the reflection beat in the template's
 * CLAUDE.md so the model already has the prior loaded from the system
 * prompt.
 */
const REFLECTION_PROMPT = [
  'You are at the end of this conversation with your operator. Take one beat and reflect: what, if anything, is worth keeping from this exchange?',
  '',
  'Four questions to check, in order:',
  '',
  '1. Did anything shift your picture of a person, account, or your own voice? If yes, use `write_memory` to capture it. Default to writing — your operator prunes.',
  '2. Did you hit friction worth surfacing (a fact you had to chase, a step that should be automated, a call you keep having to make manually)? If yes, file an `improvement` escalation via `create_escalation`.',
  '3. Did you see a recurring pattern that deserves its own playbook? If yes, draft it via `propose_verb` and file a `proposed_skill` escalation referencing the draft.',
  '4. Did you make a non-trivial decision in this conversation that deserves a logged rationale? If yes, use `log_decision`.',
  '',
  'If nothing surprised you and nothing in this conversation needs to be captured, do not manufacture observations. Just respond with a brief one-paragraph summary of what we talked about and what (if anything) remains open. The reflection beat is the discipline; the writing is optional.',
].join('\n');

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

  const parsed = ReflectBody.safeParse(body);
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

  if (thread.turns.length === 0) {
    return json(400, {
      error: 'Reflection requires at least one turn of conversation.',
    });
  }

  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(roleHome);
  } catch (error: unknown) {
    return json(500, { error: `Failed to assemble system prompt: ${errorMessage(error)}` });
  }

  const toolExecutor: ToolExecutor = async (name, input) => {
    const result = await executeTool(name, input, roleHome);
    if (result.ok) {
      const text = [`${result.summary}.`, JSON.stringify(result.data)].join('\n');
      return { ok: true, contentText: text, summary: result.summary, data: result.data };
    }
    return { ok: false, contentText: result.error };
  };

  const chatTools = await getChatTools(roleHome);

  let summaryText: string;
  let toolCalls: PersistedToolCall[];
  let truncated = false;
  try {
    const result = await sendMessageWithTools(
      systemPrompt,
      thread.turns,
      REFLECTION_PROMPT,
      chatTools,
      toolExecutor,
    );
    summaryText = result.text;
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

  // Persist the reflection block as a single assistant turn. The body is
  // prefixed with a small "Reflection · <timestamp>" header so the dashboard
  // can render it distinctly from a regular reply. Tool calls travel on the
  // turn's `toolCalls` field — same persistence shape as a normal turn.
  const reflectionBody = summaryText.length > 0
    ? `**Reflection.** ${summaryText}`
    : '**Reflection.** (No summary returned — see tool calls above.)';

  try {
    const reflectionTurn = await appendTurn(roleHome, parsed.data.thread_id, {
      role: 'assistant',
      content: reflectionBody,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    const serialized = serializeTurn(reflectionTurn);
    return json(200, {
      role: 'assistant',
      content: reflectionBody,
      content_html: serialized.content_html,
      timestamp: reflectionTurn.timestamp,
      toolCalls,
      truncated,
      kind: 'reflection',
    });
  } catch (error: unknown) {
    return json(500, {
      error: `Failed to persist reflection: ${errorMessage(error)}`,
      reply: summaryText,
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
