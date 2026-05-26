import { AIInferenceApi, Configuration } from '@quantcdn/quant-client';

import {
  aggregateStream,
  InferenceError,
  type AttachmentSupport,
  type InferenceCapability,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type StreamEvent,
} from '@praxis-framework/inference';

import {
  fromQuantResponse,
  stringifySystem,
  toBedrockMessage,
  toBedrockToolSpec,
  type BedrockMessage,
  type BedrockToolSpec,
} from './translate.js';
import { parseSSE, translateQuantStream } from './stream.js';

export interface QuantCloudProviderOptions {
  /** Override the bearer token. Falls back to QUANT_API_TOKEN. */
  accessToken?: string;
  /** Override the API base URL. Falls back to QUANT_BASE_URL, then dashboard.quantcdn.io. */
  basePath?: string;
  /** Organisation identifier. Falls back to QUANT_ORGANISATION. */
  organisation?: string;
  /** Resolved Bedrock-style model id. Falls back to the request's logical model. */
  defaultModelId?: string;
  /** Inject a pre-built AIInferenceApi (testing). */
  inferenceApi?: AIInferenceApi;
  /**
   * When true (default), `createMessage` consumes the streaming endpoint and
   * aggregates events. Set false to force the buffered `chatInference` endpoint
   * (e.g. when relying on Quant's server-side `autoExecute` of cloud-side tools).
   * Both endpoints have a 120s budget; the choice is about UX (streaming) vs
   * server-side tool execution.
   */
  preferStreaming?: boolean;
}

/**
 * Anthropic-style model names (praxis's defaults and PRAXIS_CHAT_MODEL values)
 * mapped to the Bedrock-style ids Quant's catalogue uses. Ids not in the map
 * pass through untouched, so already-Quant-style ids (anthropic.*, amazon.*)
 * and any future model still work.
 */
const MODEL_MAP: Record<string, string> = {
  'claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'claude-opus-4-6': 'anthropic.claude-opus-4-6-v1',
  'claude-opus-4-5': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5': 'anthropic.claude-haiku-4-5-20251001-v1:0',
};

interface ChatInferenceBody {
  modelId: string;
  systemPrompt?: string;
  messages: BedrockMessage[];
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  toolConfig?: { tools: BedrockToolSpec[] };
}

export class QuantCloudProvider implements InferenceProvider {
  readonly id = 'quantcloud';
  private api: AIInferenceApi;
  private org: string;
  private hasCredentials: boolean;

  constructor(private opts: QuantCloudProviderOptions = {}) {
    if (opts.inferenceApi) {
      this.api = opts.inferenceApi;
    } else {
      const accessToken = opts.accessToken ?? process.env['QUANT_API_TOKEN'];
      if (!accessToken) {
        throw new InferenceError(
          'QUANT_API_TOKEN environment variable is not set',
          'auth',
        );
      }
      const config = new Configuration({
        basePath: opts.basePath ?? process.env['QUANT_BASE_URL'] ?? 'https://dashboard.quantcdn.io',
        accessToken,
      });
      this.api = new AIInferenceApi(config);
    }
    const org = opts.organisation ?? process.env['QUANT_ORGANISATION'];
    if (!org) {
      throw new InferenceError(
        'QUANT_ORGANISATION environment variable is not set',
        'auth',
      );
    }
    this.org = org;
    this.hasCredentials = true;
  }

  resolveModel(logical: string): string {
    if (this.opts.defaultModelId) return this.opts.defaultModelId;
    return MODEL_MAP[logical] ?? logical;
  }

  has(capability: InferenceCapability): boolean {
    void capability;
    return this.hasCredentials;
  }

  supportedAttachments(): AttachmentSupport {
    return {
      images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      documents: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'text/markdown',
        'text/csv',
        'text/html',
        'text/plain',
      ],
    };
  }

  async createMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResponse> {
    if (this.preferStreaming()) {
      return aggregateStream(this.streamMessage(req, signal));
    }
    if (signal?.aborted) throw abortError(signal);
    const body = this.buildBody(req);
    try {
      // The Quant SDK wraps Axios — pass `signal` through the Axios request
      // config so the underlying HTTP request is actually cancelled.
      const res = await this.api.chatInference(
        this.org,
        body as never,
        (signal ? { signal } : undefined) as never,
      );
      return fromQuantResponse(res.data as never);
    } catch (error: unknown) {
      throw wrapError(error);
    }
  }

  async *streamMessage(
    req: InferenceRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const body: ChatInferenceBody & { stream: true } = {
      ...this.buildBody(req),
      stream: true,
    };

    if (signal?.aborted) throw abortError(signal);

    let upstream: { data: AsyncIterable<Buffer | string | Uint8Array> };
    try {
      // Pass `signal` through the Axios request config so the SDK cancels the
      // upstream HTTP request itself. Falls back to the per-event check below
      // for the inter-event window if the SDK ever stops honouring signal.
      upstream = (await this.api.chatInferenceStream(this.org, body as never, {
        responseType: 'stream',
        headers: { Accept: 'text/event-stream' },
        ...(signal ? { signal } : {}),
      } as never)) as never;
    } catch (error: unknown) {
      throw wrapError(error);
    }

    try {
      for await (const ev of translateQuantStream(parseSSE(upstream.data))) {
        if (signal?.aborted) throw abortError(signal);
        yield ev;
      }
    } catch (error: unknown) {
      throw wrapError(error);
    }
  }

  private preferStreaming(): boolean {
    if (this.opts.preferStreaming !== undefined) return this.opts.preferStreaming;
    if (process.env['QUANT_PREFER_STREAMING'] === 'false') return false;
    return true;
  }

  private buildBody(req: InferenceRequest): ChatInferenceBody {
    const body: ChatInferenceBody = {
      modelId: this.resolveModel(req.model),
      messages: req.messages.map(toBedrockMessage),
      maxTokens: req.max_tokens,
    };
    const systemPrompt = stringifySystem(req.system);
    if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.stop_sequences) body.stopSequences = req.stop_sequences;
    if (req.tools?.length) {
      body.toolConfig = { tools: req.tools.map(toBedrockToolSpec) };
    }
    return body;
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
    `Quant Cloud request aborted: ${reason.message}`,
    'network',
    reason,
  );
}

function wrapError(error: unknown): InferenceError {
  const status = readStatus(error);
  if (status !== undefined) {
    const code =
      status === 429
        ? 'rate_limit'
        : status === 401 || status === 403
          ? 'auth'
          : 'provider';
    return new InferenceError(
      `Quant Cloud API error (${status}): ${(error as Error).message}`,
      code,
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new InferenceError(`Quant Cloud request failed: ${message}`, 'network', error);
}

function readStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const e = error as { response?: { status?: number }; status?: number };
  return e.response?.status ?? e.status;
}
