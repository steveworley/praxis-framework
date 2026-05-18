import Anthropic from '@anthropic-ai/sdk';

import {
  InferenceError,
  type ContentBlock,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
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
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
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
  }

  resolveModel(logical: string): string {
    return logical;
  }

  async createMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.resolveModel(req.model),
      max_tokens: req.max_tokens,
      system: req.system as Anthropic.MessageCreateParamsNonStreaming['system'],
      messages: req.messages as Anthropic.MessageCreateParamsNonStreaming['messages'],
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
      messages: req.messages as Anthropic.MessageCreateParamsStreaming['messages'],
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
