import Anthropic from '@anthropic-ai/sdk';

import {
  InferenceError,
  type AttachmentSupport,
  type ContentBlock,
  type InferenceCapability,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type Message,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '../types.js';

export interface AnthropicProviderOptions {
  apiKey?: string;
  client?: Anthropic;
}

export class AnthropicProvider implements InferenceProvider {
  readonly id = 'anthropic';
  private hasCredentials: boolean;
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
      this.hasCredentials = true;
      return;
    }
    const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new InferenceError(
        'ANTHROPIC_API_KEY environment variable is not set',
        'auth',
      );
    }
    this.client = new Anthropic({ apiKey });
    this.hasCredentials = true;
  }

  resolveModel(logical: string): string {
    return logical;
  }

  has(capability: InferenceCapability): boolean {
    // Anthropic supports streaming and tools whenever it has chat.
    void capability;
    return this.hasCredentials;
  }

  supportedAttachments(): AttachmentSupport {
    return {
      images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      documents: ['application/pdf'],
    };
  }

  async createMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.resolveModel(req.model),
      max_tokens: req.max_tokens,
      system: req.system as Anthropic.MessageCreateParamsNonStreaming['system'],
      messages: toAnthropicMessages(
        req.messages,
      ) as Anthropic.MessageCreateParamsNonStreaming['messages'],
    };
    if (req.tools?.length) {
      params.tools = req.tools as Anthropic.Tool[];
    }
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.stop_sequences) params.stop_sequences = req.stop_sequences;

    if (signal?.aborted) throw abortError(signal);

    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(params, signal ? { signal } : undefined);
    } catch (error: unknown) {
      throw wrapError(error);
    }

    return {
      id: res.id,
      model: res.model,
      content: res.content as ContentBlock[],
      stop_reason: (res.stop_reason ?? 'end_turn') as StopReason,
      usage: res.usage as Usage,
      raw: res,
    };
  }

  async *streamMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.resolveModel(req.model),
      max_tokens: req.max_tokens,
      system: req.system as Anthropic.MessageCreateParamsStreaming['system'],
      messages: toAnthropicMessages(
        req.messages,
      ) as Anthropic.MessageCreateParamsStreaming['messages'],
      stream: true,
    };
    if (req.tools?.length) params.tools = req.tools as Anthropic.Tool[];
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.stop_sequences) params.stop_sequences = req.stop_sequences;

    if (signal?.aborted) throw abortError(signal);

    let stream: AsyncIterable<unknown>;
    try {
      stream = this.client.messages.stream(
        params,
        signal ? { signal } : undefined,
      ) as unknown as AsyncIterable<unknown>;
    } catch (error: unknown) {
      throw wrapError(error);
    }

    try {
      for await (const ev of stream) {
        if (signal?.aborted) throw abortError(signal);
        const translated = translateStreamEvent(ev);
        if (translated) yield translated;
      }
    } catch (error: unknown) {
      throw wrapError(error);
    }
  }
}

/**
 * Map neutral messages into the shape the Anthropic SDK expects. Our neutral
 * `document` block carries the original filename in `name`; the SDK's document
 * block has no `name` field and uses an optional `title` instead. Every other
 * block type — and plain string content — passes through untouched.
 *
 * Exported for unit testing without a network call; callers should use the
 * provider methods. The result is still cast to the SDK's `messages` type at
 * the call site because the document `title` shape diverges from `ContentBlock`.
 */
export function toAnthropicMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message;
    return {
      ...message,
      content: message.content.map(toAnthropicBlock),
    };
  });
}

function toAnthropicBlock(block: ContentBlock): ContentBlock {
  if (block.type !== 'document') return block;
  const { name, ...rest } = block;
  return {
    ...rest,
    ...(name ? { title: name } : {}),
  } as unknown as ContentBlock;
}

function abortError(signal: AbortSignal): InferenceError {
  const reason =
    signal.reason instanceof Error
      ? signal.reason
      : signal.reason !== undefined
        ? new Error(String(signal.reason))
        : new Error('aborted');
  return new InferenceError(
    `Anthropic request aborted: ${reason.message}`,
    'network',
    reason,
  );
}

interface SDKMessageStartEvent {
  type: 'message_start';
  message: { id: string; model: string };
}
interface SDKContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
}
interface SDKContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
}
interface SDKContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}
interface SDKMessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason?: StopReason | null; stop_sequence?: string | null };
  usage?: Partial<Usage>;
}
interface SDKMessageStopEvent {
  type: 'message_stop';
}

type SDKStreamEvent =
  | SDKMessageStartEvent
  | SDKContentBlockStartEvent
  | SDKContentBlockDeltaEvent
  | SDKContentBlockStopEvent
  | SDKMessageDeltaEvent
  | SDKMessageStopEvent;

function translateStreamEvent(ev: unknown): StreamEvent | null {
  if (!ev || typeof ev !== 'object' || !('type' in ev)) return null;
  const e = ev as SDKStreamEvent;
  switch (e.type) {
    case 'message_start':
      return { type: 'message_start', id: e.message.id, model: e.message.model };
    case 'content_block_start':
      return { type: 'content_block_start', index: e.index, content_block: e.content_block };
    case 'content_block_delta':
      return { type: 'content_block_delta', index: e.index, delta: e.delta };
    case 'content_block_stop':
      return { type: 'content_block_stop', index: e.index };
    case 'message_delta': {
      const event: StreamEvent = {
        type: 'message_delta',
        delta: {
          ...(e.delta.stop_reason ? { stop_reason: e.delta.stop_reason } : {}),
          ...(e.delta.stop_sequence !== undefined ? { stop_sequence: e.delta.stop_sequence } : {}),
        },
      };
      if (e.usage) event.usage = e.usage;
      return event;
    }
    case 'message_stop':
      return { type: 'message_stop' };
    default:
      return null;
  }
}

function wrapError(error: unknown): InferenceError {
  if (error instanceof Anthropic.APIError) {
    const code: 'rate_limit' | 'auth' | 'provider' =
      error.status === 429
        ? 'rate_limit'
        : error.status === 401 || error.status === 403
          ? 'auth'
          : 'provider';
    return new InferenceError(
      `Anthropic API error (${error.status ?? 'unknown'}): ${error.message}`,
      code,
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new InferenceError(`Anthropic request failed: ${message}`, 'network', error);
}
