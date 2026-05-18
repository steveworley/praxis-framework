import {
  aggregateStream,
  AnthropicProvider,
  InferenceError,
  type ContentBlock,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type Message,
  type StreamEvent,
  type ToolDef,
} from '@praxis-framework/inference';

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
  constructor(message = 'ANTHROPIC_API_KEY environment variable is not set') {
    super(message);
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
 * `claude-sonnet-4-6`. The provider is responsible for translating this logical
 * id to a concrete one (e.g. AnthropicProvider passes it through; QuantCloudProvider
 * may resolve it to a Bedrock-style id).
 */
export function resolveChatModel(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env['PRAXIS_CHAT_MODEL'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_MODEL;
}

/**
 * Whether the configured provider has credentials available. The Anthropic
 * provider checks ANTHROPIC_API_KEY; the QuantCloud provider checks
 * QUANT_API_TOKEN.
 */
export function hasApiKey(): boolean {
  const id = providerId();
  if (id === 'quantcloud') {
    const t = process.env['QUANT_API_TOKEN'];
    return typeof t === 'string' && t.length > 0;
  }
  const k = process.env['ANTHROPIC_API_KEY'];
  return typeof k === 'string' && k.length > 0;
}

/**
 * Human-readable message naming the env var the configured provider needs
 * but hasn't been given. Used by API routes so operators see "QUANT_API_TOKEN
 * is not set" when running against QuantCloud, not the hardcoded
 * ANTHROPIC_API_KEY.
 */
export function missingApiKeyMessage(): string {
  const id = providerId();
  const envVar = id === 'quantcloud' ? 'QUANT_API_TOKEN' : 'ANTHROPIC_API_KEY';
  return `${envVar} is not set. The chat surface is disabled.`;
}

/**
 * Translate stored turns into the provider-neutral Message shape.
 *
 * Tool calls are NOT replayed back to the model on subsequent turns — once a
 * thread is loaded from disk, we send the assistant's final reply text only.
 *
 * Summary turns are translated to a user-role message with a "Summary of
 * earlier turns" preface so the model treats them as established context.
 */
export function buildMessages(history: Turn[]): Message[] {
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

export interface ToolExecResult {
  ok: boolean;
  contentText: string;
  data?: Record<string, unknown>;
  summary?: string;
}

export type ToolExecutor = (name: string, input: unknown) => Promise<ToolExecResult>;

export interface SendMessageResult {
  text: string;
  toolCalls: PersistedToolCall[];
  truncated: boolean;
}

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

export async function sendMessageWithTools(
  systemPrompt: string,
  history: Turn[],
  userContent: string,
  tools: readonly ToolDef[],
  executeTool: ToolExecutor,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const provider = await loadProvider();

  const messages: Message[] = [
    ...buildMessages(history),
    { role: 'user', content: userContent },
  ];

  const toolCalls: PersistedToolCall[] = [];
  let finalText = '';
  let truncated = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
    const response = await callProvider(provider, {
      model: resolveChatModel(options.model),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? [...tools] : undefined,
    });

    finalText = extractText(response.content);

    if (response.stop_reason !== 'tool_use') {
      return { text: finalText, toolCalls, truncated };
    }

    const toolUseBlocks: Array<Extract<ContentBlock, { type: 'tool_use' }>> = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') toolUseBlocks.push(block);
    }

    const resultBlocks: Array<Extract<ContentBlock, { type: 'tool_result' }>> = [];
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

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: resultBlocks });

    if (iter === MAX_TOOL_ITERATIONS - 1) {
      truncated = true;
    }
  }

  return { text: finalText, toolCalls, truncated };
}

function providerId(): string {
  return process.env['PRAXIS_INFERENCE_PROVIDER'] ?? 'anthropic';
}

let cachedProvider: InferenceProvider | null = null;

async function loadProvider(): Promise<InferenceProvider> {
  if (cachedProvider) return cachedProvider;
  const id = providerId();
  try {
    if (id === 'anthropic') {
      cachedProvider = new AnthropicProvider();
    } else if (id === 'quantcloud') {
      // Lazy import so OSS users without the optional package don't pay the load.
      const mod = await import('@praxis-framework/inference-quantcloud');
      cachedProvider = new mod.QuantCloudProvider();
    } else {
      throw new AnthropicChatError(`Unknown PRAXIS_INFERENCE_PROVIDER: ${id}`);
    }
  } catch (error: unknown) {
    if (error instanceof InferenceError && error.code === 'auth') {
      throw new MissingApiKeyError(error.message);
    }
    if (error instanceof AnthropicChatError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AnthropicChatError(`Failed to load inference provider: ${message}`, error);
  }
  return cachedProvider;
}

/** Test seam: reset the cached provider between tests. */
export function resetProviderForTesting(): void {
  cachedProvider = null;
}

async function callProvider(
  provider: InferenceProvider,
  req: Parameters<InferenceProvider['createMessage']>[0],
) {
  try {
    return await provider.createMessage(req);
  } catch (error: unknown) {
    if (error instanceof InferenceError) {
      if (error.code === 'auth') throw new MissingApiKeyError(error.message);
      throw new AnthropicChatError(error.message, error.cause ?? error);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AnthropicChatError(`Inference request failed: ${message}`, error);
  }
}

function extractText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}

export type ChatStreamEvent =
  | { type: 'inference_event'; event: StreamEvent }
  | { type: 'tool_start'; name: string; input: unknown; toolUseId: string }
  | { type: 'tool_complete'; name: string; toolUseId: string; result: ToolExecResult }
  | { type: 'complete'; result: SendMessageResult };

/**
 * Streaming variant of `sendMessageWithTools`. Yields:
 *   - `inference_event` for each provider stream event (use to push SSE deltas
 *     to a browser),
 *   - `tool_start` / `tool_complete` around each tool execution,
 *   - `complete` once, at the end, carrying the same `SendMessageResult` shape
 *     as `sendMessageWithTools`.
 *
 * Falls back to `createMessage` if the configured provider does not implement
 * `streamMessage` — callers still receive `complete`, just without any
 * `inference_event` items in between.
 */
export async function* streamMessageWithTools(
  systemPrompt: string,
  history: Turn[],
  userContent: string,
  tools: readonly ToolDef[],
  executeTool: ToolExecutor,
  options: SendMessageOptions = {},
): AsyncIterable<ChatStreamEvent> {
  const provider = await loadProvider();

  const messages: Message[] = [
    ...buildMessages(history),
    { role: 'user', content: userContent },
  ];

  const toolCalls: PersistedToolCall[] = [];
  let finalText = '';
  let truncated = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
    const req: InferenceRequest = {
      model: resolveChatModel(options.model),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages,
      ...(tools.length > 0 ? { tools: [...tools] } : {}),
    };

    let response: InferenceResponse;
    try {
      if (provider.streamMessage) {
        const collected: StreamEvent[] = [];
        for await (const ev of provider.streamMessage(req)) {
          yield { type: 'inference_event', event: ev };
          collected.push(ev);
        }
        response = await aggregateStream(replay(collected));
      } else {
        response = await provider.createMessage(req);
      }
    } catch (error: unknown) {
      if (error instanceof InferenceError) {
        if (error.code === 'auth') throw new MissingApiKeyError(error.message);
        throw new AnthropicChatError(error.message, error.cause ?? error);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AnthropicChatError(`Inference request failed: ${message}`, error);
    }

    finalText = extractText(response.content);

    if (response.stop_reason !== 'tool_use') {
      yield { type: 'complete', result: { text: finalText, toolCalls, truncated } };
      return;
    }

    const toolUseBlocks: Array<Extract<ContentBlock, { type: 'tool_use' }>> = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') toolUseBlocks.push(block);
    }

    const resultBlocks: Array<Extract<ContentBlock, { type: 'tool_result' }>> = [];
    for (const block of toolUseBlocks) {
      yield { type: 'tool_start', name: block.name, input: block.input, toolUseId: block.id };
      const execResult = await executeTool(block.name, block.input);
      yield {
        type: 'tool_complete',
        name: block.name,
        toolUseId: block.id,
        result: execResult,
      };

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

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: resultBlocks });

    if (iter === MAX_TOOL_ITERATIONS - 1) truncated = true;
  }

  yield { type: 'complete', result: { text: finalText, toolCalls, truncated } };
}

function replay<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}
