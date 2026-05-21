export type Role = 'user' | 'assistant';

export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    };

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface InferenceRequest {
  model: string;
  system?: string | ContentBlock[];
  messages: Message[];
  tools?: ToolDef[];
  max_tokens: number;
  temperature?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string; [k: string]: unknown };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'error';

export interface InferenceResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: Usage;
  raw?: unknown;
}

export type ContentBlockStart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export type StreamEvent =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'content_block_start'; index: number; content_block: ContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason?: StopReason; stop_sequence?: string | null };
      usage?: Partial<Usage>;
    }
  | { type: 'message_stop' };

export type InferenceCapability = 'chat' | 'streaming' | 'tools';

export interface InferenceProvider {
  readonly id: string;
  createMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResponse>;
  streamMessage?(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
  resolveModel(logical: string): string;
  /**
   * Capability gate.
   *
   * `chat`     — credentials present and the provider can serve a request now.
   * `streaming` — provider can emit token-by-token events (implies `chat`).
   * `tools`    — provider supports the Anthropic-shape tool loop (implies `chat`).
   *
   * Implementations may short-circuit: a `false` from `chat` implies `false` for
   * `streaming` and `tools`.
   */
  has(capability: InferenceCapability): boolean;
}

export type InferenceErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'context'
  | 'provider'
  | 'network';

export class InferenceError extends Error {
  override readonly cause?: unknown;
  constructor(
    message: string,
    readonly code: InferenceErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'InferenceError';
    if (cause !== undefined) this.cause = cause;
  }
}
