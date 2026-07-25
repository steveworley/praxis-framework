import OpenAI from 'openai';

import {
  InferenceError,
  type AttachmentSupport,
  type InferenceCapability,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type StreamEvent,
} from '@praxis-framework/inference';

import {
  fromOpenAIResponse,
  stringifySystem,
  toOpenAIMessages,
  toOpenAITool,
} from './translate.js';
import { translateKimiStream } from './stream.js';

/** Default Kimi API base URL. */
const KIMI_BASE_URL = 'https://api.moonshot.cn/v1';

/**
 * Well-known Kimi model aliases. Logical names used in praxis inference
 * requests are mapped to their canonical Moonshot ids here. Unknown ids
 * pass through untouched.
 */
const MODEL_MAP: Record<string, string> = {
  'moonshot-v1-8k': 'moonshot-v1-8k',
  'moonshot-v1-32k': 'moonshot-v1-32k',
  'moonshot-v1-128k': 'moonshot-v1-128k',
  // Short aliases for convenience inside praxis config.
  'kimi-8k': 'moonshot-v1-8k',
  'kimi-32k': 'moonshot-v1-32k',
  'kimi-128k': 'moonshot-v1-128k',
  // Auto-size alias: Moonshot picks the context window based on token count.
  'kimi-auto': 'moonshot-v1-auto',
};

export interface KimiProviderOptions {
  /** Kimi API key. Falls back to KIMI_API_KEY env var. */
  apiKey?: string;
  /** Override the API base URL. Falls back to KIMI_BASE_URL env var, then `https://api.moonshot.cn/v1`. */
  baseURL?: string;
  /** Inject a pre-built OpenAI client (for testing). */
  client?: OpenAI;
  /**
   * Default model id to use when no mapping is found. Falls back to the
   * logical model name in the request.
   */
  defaultModel?: string;
}

export class KimiProvider implements InferenceProvider {
  readonly id = 'kimi';
  private client: OpenAI;
  private hasCredentials: boolean;
  private opts: KimiProviderOptions;

  constructor(opts: KimiProviderOptions = {}) {
    this.opts = opts;
    if (opts.client) {
      this.client = opts.client;
      this.hasCredentials = true;
      return;
    }
    const apiKey = opts.apiKey ?? process.env['KIMI_API_KEY'];
    if (!apiKey) {
      throw new InferenceError(
        'KIMI_API_KEY environment variable is not set',
        'auth',
      );
    }
    const baseURL = opts.baseURL ?? process.env['KIMI_BASE_URL'] ?? KIMI_BASE_URL;
    this.client = new OpenAI({ apiKey, baseURL });
    this.hasCredentials = true;
  }

  resolveModel(logical: string): string {
    if (this.opts.defaultModel) return this.opts.defaultModel;
    return MODEL_MAP[logical] ?? logical;
  }

  has(capability: InferenceCapability): boolean {
    // Kimi supports streaming and tools whenever it has chat (credentials present).
    void capability;
    return this.hasCredentials;
  }

  supportedAttachments(): AttachmentSupport {
    return {
      images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      documents: [],
    };
  }

  async createMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    if (signal?.aborted) throw abortError(signal);

    const params = this.buildParams(req);

    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(params, signal ? { signal } : undefined);
    } catch (error: unknown) {
      throw wrapError(error);
    }

    return fromOpenAIResponse(res);
  }

  async *streamMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    if (signal?.aborted) throw abortError(signal);

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      ...this.buildParams(req),
      stream: true,
      stream_options: { include_usage: true },
    };

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        params,
        signal ? { signal } : undefined,
      );
    } catch (error: unknown) {
      throw wrapError(error);
    }

    try {
      for await (const ev of translateKimiStream(stream)) {
        if (signal?.aborted) throw abortError(signal);
        yield ev;
      }
    } catch (error: unknown) {
      if (error instanceof InferenceError) throw error;
      throw wrapError(error);
    }
  }

  private buildParams(req: InferenceRequest): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    const systemText = stringifySystem(req.system);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }

    messages.push(...toOpenAIMessages(req.messages));

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.resolveModel(req.model),
      messages,
      max_tokens: req.max_tokens,
    };

    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.stop_sequences?.length) {
      params.stop = req.stop_sequences;
    }
    if (req.tools?.length) {
      params.tools = req.tools.map(toOpenAITool);
    }

    return params;
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
    `Kimi request aborted: ${reason.message}`,
    'network',
    reason,
  );
}

function wrapError(error: unknown): InferenceError {
  if (error instanceof OpenAI.APIError) {
    const code: 'rate_limit' | 'auth' | 'provider' =
      error.status === 429
        ? 'rate_limit'
        : error.status === 401 || error.status === 403
          ? 'auth'
          : 'provider';
    return new InferenceError(
      `Kimi API error (${error.status ?? 'unknown'}): ${error.message}`,
      code,
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new InferenceError(`Kimi request failed: ${message}`, 'network', error);
}
