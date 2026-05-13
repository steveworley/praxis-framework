import Anthropic from '@anthropic-ai/sdk';

import type { PersistedToolCall, Turn } from './conversation.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2048;
const MAX_TOOL_ITERATIONS = 10;

export interface SendMessageOptions {
  /** Override the default model. Falls back to PRAXIS_CHAT_MODEL env var, then the hard default. */
  model?: string;
  /** Override max_tokens. Defaults to 2048. */
  maxTokens?: number;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY environment variable is not set');
    this.name = 'MissingApiKeyError';
  }
}

export class AnthropicChatError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AnthropicChatError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Resolve the chat model from env (PRAXIS_CHAT_MODEL) with a hard default of
 * `claude-sonnet-4-6` — Sonnet 4.6 is the recommended balance of intelligence
 * and cost for conversational surfaces.
 */
export function resolveChatModel(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env['PRAXIS_CHAT_MODEL'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_MODEL;
}

/**
 * Whether the env carries an API key. Used by the UI to render a clean
 * "missing key" empty state instead of triggering the API call.
 */
export function hasApiKey(): boolean {
  const key = process.env['ANTHROPIC_API_KEY'];
  return typeof key === 'string' && key.length > 0;
}

/**
 * Translate stored turns into the Anthropic SDK's MessageParam shape.
 * Exported for testing the request shape.
 *
 * Tool calls are NOT replayed back to the model on subsequent turns — once a
 * thread is loaded from disk, we send the assistant's final reply text only.
 * The model has the reply in its conversational context; replaying tool_use
 * + tool_result blocks would require keeping the original tool_use ids in
 * sync across loads, which adds complexity without a clear benefit.
 *
 * Summary turns are translated to a user-role message with a "Summary of
 * earlier turns" preface so the model treats them as established context.
 */
export function buildMessages(history: Turn[]): Anthropic.MessageParam[] {
  return history.map((turn) => {
    if (turn.role === 'summary') {
      const range = turn.summaryRange
        ? `turns ${turn.summaryRange.from}-${turn.summaryRange.to}`
        : 'earlier turns';
      return {
        role: 'user',
        content: `Summary of ${range} of this conversation:\n\n${turn.content}`,
      };
    }
    return { role: turn.role, content: turn.content };
  });
}

/**
 * Tool result handed back to the model. The executor returns either ok+data
 * or fail+error; the loop turns that into a tool_result block (is_error true
 * on fail).
 */
export interface ToolExecResult {
  ok: boolean;
  /** Plain-text payload the model sees in its tool_result content. */
  contentText: string;
  /** Structured data preserved for persistence (UI rendering). */
  data?: Record<string, unknown>;
  /** Short human summary surfaced to the operator in the UI. */
  summary?: string;
}

export type ToolExecutor = (name: string, input: unknown) => Promise<ToolExecResult>;

export interface SendMessageResult {
  /** Final assistant text (the model's last `text` content block). */
  text: string;
  /** All tool calls made during the loop, in execution order. */
  toolCalls: PersistedToolCall[];
  /** True when the loop hit the iteration cap before the model said "end_turn". */
  truncated: boolean;
}

/**
 * Single-turn chat completion. Backwards-compatible signature: no tools,
 * returns the assistant text. Internally just a thin wrapper around
 * `sendMessageWithTools` with an empty tools array.
 */
export async function sendMessage(
  systemPrompt: string,
  history: Turn[],
  userContent: string,
  options: SendMessageOptions = {},
): Promise<string> {
  const result = await sendMessageWithTools(
    systemPrompt,
    history,
    userContent,
    [],
    async () => ({ ok: false, contentText: 'No tools available.' }),
    options,
  );
  return result.text;
}

/**
 * Chat completion with tool-use loop. Loops while the model emits `tool_use`
 * blocks; executes each via `executeTool`; appends the assistant turn + the
 * tool_result blocks to the message stack; repeats up to MAX_TOOL_ITERATIONS.
 *
 * Returns the final assistant text + all tool calls made (in order). The
 * `truncated` flag is true when the cap is hit before the model says
 * `end_turn` — the caller can surface that as a warning.
 *
 * Error handling: SDK errors are wrapped in `AnthropicChatError` and thrown.
 * Tool execution failures do NOT throw — they become `is_error: true`
 * tool_result blocks the model sees and can recover from.
 */
export async function sendMessageWithTools(
  systemPrompt: string,
  history: Turn[],
  userContent: string,
  tools: readonly Anthropic.Tool[],
  executeTool: ToolExecutor,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.length === 0) {
    throw new MissingApiKeyError();
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...buildMessages(history),
    { role: 'user', content: userContent },
  ];

  const toolCalls: PersistedToolCall[] = [];
  let finalText = '';
  let truncated = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
    let response: Anthropic.Message;
    try {
      const createParams: Anthropic.MessageCreateParamsNonStreaming = {
        model: resolveChatModel(options.model),
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages,
      };
      if (tools.length > 0) createParams.tools = [...tools];
      response = await client.messages.create(createParams);
    } catch (error: unknown) {
      if (error instanceof Anthropic.APIError) {
        throw new AnthropicChatError(
          `Anthropic API error (${error.status ?? 'unknown'}): ${error.message}`,
          error,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AnthropicChatError(`Anthropic request failed: ${message}`, error);
    }

    // Always keep the last text response. The Anthropic API guarantees text
    // content is present on every turn, but tool_use blocks may follow.
    finalText = extractText(response);

    if (response.stop_reason !== 'tool_use') {
      // Normal end of turn (`end_turn`, `max_tokens`, `stop_sequence`, etc).
      return { text: finalText, toolCalls, truncated };
    }

    // The model wants to call tools. Collect the tool_use blocks, run each,
    // then append (a) the assistant turn verbatim and (b) the user turn
    // with the matching tool_result blocks.
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') toolUseBlocks.push(block);
    }

    const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const execResult = await executeTool(block.name, block.input);
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: execResult.contentText,
        is_error: !execResult.ok,
      });

      const inputRecord: Record<string, unknown> =
        typeof block.input === 'object' && block.input !== null
          ? { ...(block.input as Record<string, unknown>) }
          : { value: block.input };

      const persisted: PersistedToolCall = {
        name: block.name,
        input: inputRecord,
        result: execResult.ok
          ? {
              ok: true,
              ...(execResult.summary ? { summary: execResult.summary } : {}),
              ...(execResult.data ? { data: execResult.data } : {}),
            }
          : { ok: false, error: execResult.contentText },
      };
      toolCalls.push(persisted);
    }

    // The assistant content needs to be passed back verbatim so the model
    // sees its own tool_use blocks paired with the tool_result blocks.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: resultBlocks });

    if (iter === MAX_TOOL_ITERATIONS - 1) {
      truncated = true;
    }
  }

  return { text: finalText, toolCalls, truncated };
}

function extractText(response: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}
