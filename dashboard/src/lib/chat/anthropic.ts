import Anthropic from '@anthropic-ai/sdk';

import type { Turn } from './conversation.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2048;

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
 */
export function buildMessages(history: Turn[]): Anthropic.MessageParam[] {
  return history.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * Single-turn chat completion. The conversation's `history` should NOT yet
 * include the new `userContent` — this function appends it and sends the
 * complete message list. Returns the assistant's text response.
 */
export async function sendMessage(
  systemPrompt: string,
  history: Turn[],
  userContent: string,
  options: SendMessageOptions = {},
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.length === 0) {
    throw new MissingApiKeyError();
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...buildMessages(history),
    { role: 'user', content: userContent },
  ];

  try {
    const response = await client.messages.create({
      model: resolveChatModel(options.model),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      messages,
    });
    return extractText(response);
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
}

function extractText(response: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}
