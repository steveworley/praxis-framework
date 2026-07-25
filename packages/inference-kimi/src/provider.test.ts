import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createSpy = vi.fn();
const constructorSpy = vi.fn();

vi.mock('openai', () => {
  class APIError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class OpenAI {
    chat: { completions: { create: typeof createSpy } };
    constructor(opts: unknown) {
      constructorSpy(opts);
      this.chat = { completions: { create: createSpy } };
    }
    static APIError = APIError;
  }
  return { default: OpenAI, APIError };
});

let prevKey: string | undefined;

beforeEach(() => {
  createSpy.mockReset();
  constructorSpy.mockReset();
  prevKey = process.env['KIMI_API_KEY'];
});

afterEach(() => {
  if (prevKey === undefined) delete process.env['KIMI_API_KEY'];
  else process.env['KIMI_API_KEY'] = prevKey;
});

describe('KimiProvider.createMessage', () => {
  it('forwards model, system, messages, and max_tokens to the OpenAI client', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-1',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi back', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      created: 0,
      object: 'chat.completion',
    });

    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    const res = await provider.createMessage({
      model: 'moonshot-v1-8k',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });

    expect(res).toMatchObject({
      id: 'chatcmpl-1',
      model: 'moonshot-v1-8k',
      content: [{ type: 'text', text: 'hi back' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const params = createSpy.mock.calls[0]![0];
    expect(params.model).toBe('moonshot-v1-8k');
    expect(params.max_tokens).toBe(100);
    expect(params.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(params.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('throws InferenceError(code=auth) when KIMI_API_KEY is missing', async () => {
    delete process.env['KIMI_API_KEY'];
    const { KimiProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const err = (() => {
      try {
        new KimiProvider();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as InstanceType<typeof InferenceError>).code).toBe('auth');
  });

  it('accepts apiKey via constructor option without env var', async () => {
    delete process.env['KIMI_API_KEY'];
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-x',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider({ apiKey: 'sk-direct' });
    const res = await provider.createMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    });
    expect(res.stop_reason).toBe('end_turn');
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-direct' }),
    );
  });

  it('accepts a pre-built client (testing seam)', async () => {
    delete process.env['KIMI_API_KEY'];
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-y',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const OpenAI = (await import('openai')).default;
    const fakeClient = new OpenAI({ apiKey: 'fake' }) as unknown as ConstructorParameters<typeof KimiProvider>[0]['client'];
    const provider = new KimiProvider({ client: fakeClient });
    expect(provider.has('chat')).toBe(true);
    const res = await provider.createMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    });
    expect(res.stop_reason).toBe('end_turn');
  });

  it('wraps OpenAI.APIError with rate_limit code for HTTP 429', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const sdk = await import('openai');
    const APIError = (sdk.default as unknown as { APIError: new (m: string, s: number) => Error }).APIError;
    createSpy.mockRejectedValueOnce(new APIError('rate limited', 429));
    const { KimiProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const provider = new KimiProvider();
    const err = await provider
      .createMessage({
        model: 'moonshot-v1-8k',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as InstanceType<typeof InferenceError>).code).toBe('rate_limit');
    expect((err as Error).message).toMatch(/429/);
  });

  it('wraps OpenAI.APIError with auth code for HTTP 401', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const sdk = await import('openai');
    const APIError = (sdk.default as unknown as { APIError: new (m: string, s: number) => Error }).APIError;
    createSpy.mockRejectedValueOnce(new APIError('unauthorised', 401));
    const { KimiProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const provider = new KimiProvider();
    const err = await provider
      .createMessage({
        model: 'moonshot-v1-8k',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as InstanceType<typeof InferenceError>).code).toBe('auth');
  });

  it('forwards temperature and stop_sequences when set', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-2',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    await provider.createMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      temperature: 0.5,
      stop_sequences: ['END'],
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      temperature: 0.5,
      stop: ['END'],
    });
  });

  it('does not set tools when the tools array is empty or absent', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-3',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    await provider.createMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      tools: [],
    });
    expect(createSpy.mock.calls[0]![0]).not.toHaveProperty('tools');
  });

  it('includes tools when tools are provided', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-4',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    await provider.createMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      tools: [
        {
          name: 'write_memory',
          description: 'persist a note',
          input_schema: { type: 'object', properties: { body: { type: 'string' } } },
        },
      ],
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_memory',
            description: 'persist a note',
            parameters: { type: 'object', properties: { body: { type: 'string' } } },
          },
        },
      ],
    });
  });

  it('throws InferenceError immediately when createMessage is called with an already-aborted signal', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const provider = new KimiProvider();
    const controller = new AbortController();
    controller.abort();
    const err = await provider
      .createMessage(
        {
          model: 'moonshot-v1-8k',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 50,
        },
        controller.signal,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as Error).message).toMatch(/aborted/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('forwards the AbortSignal to the OpenAI client options when createMessage is called', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'chatcmpl-5',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls: undefined },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion',
    });
    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    const controller = new AbortController();
    await provider.createMessage(
      {
        model: 'moonshot-v1-8k',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      },
      controller.signal,
    );
    expect(createSpy.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it('translates stream events during streamMessage', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const sdkChunks = [
      {
        id: 'chatcmpl-s1',
        model: 'moonshot-v1-8k',
        created: 0,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 'chatcmpl-s1',
        model: 'moonshot-v1-8k',
        created: 0,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      },
    ];
    createSpy.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        for (const c of sdkChunks) yield c;
      },
    });

    const { KimiProvider } = await import('./provider.ts');
    const provider = new KimiProvider();
    const collected: unknown[] = [];
    for await (const ev of provider.streamMessage({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    })) {
      collected.push(ev);
    }

    expect(collected).toContainEqual(
      expect.objectContaining({ type: 'message_start', id: 'chatcmpl-s1' }),
    );
    expect(collected).toContainEqual(
      expect.objectContaining({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
    );
    expect(collected[collected.length - 1]).toMatchObject({ type: 'message_stop' });
  });

  it('throws InferenceError immediately when streamMessage is called with an already-aborted signal', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const provider = new KimiProvider();
    const controller = new AbortController();
    controller.abort();
    const err = await (async () => {
      try {
        for await (const _ev of provider.streamMessage(
          {
            model: 'moonshot-v1-8k',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 50,
          },
          controller.signal,
        )) {
          // unreachable
        }
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as Error).message).toMatch(/aborted/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('KimiProvider.resolveModel', () => {
  it('maps short kimi aliases to canonical moonshot model ids', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const p = new KimiProvider();
    expect(p.resolveModel('kimi-8k')).toBe('moonshot-v1-8k');
    expect(p.resolveModel('kimi-32k')).toBe('moonshot-v1-32k');
    expect(p.resolveModel('kimi-128k')).toBe('moonshot-v1-128k');
  });

  it('passes through unrecognised model ids unchanged', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const p = new KimiProvider();
    expect(p.resolveModel('custom-model-id')).toBe('custom-model-id');
  });

  it('honours defaultModel option when set', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const p = new KimiProvider({ defaultModel: 'moonshot-v1-128k' });
    expect(p.resolveModel('kimi-8k')).toBe('moonshot-v1-128k');
  });
});

describe('KimiProvider.has(capability)', () => {
  it('returns true for all capabilities when api key is present', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const p = new KimiProvider();
    expect(p.has('chat')).toBe(true);
    expect(p.has('streaming')).toBe(true);
    expect(p.has('tools')).toBe(true);
  });
});

describe('KimiProvider.supportedAttachments()', () => {
  it('reports the native image MIME types and empty documents list', async () => {
    process.env['KIMI_API_KEY'] = 'sk-test';
    const { KimiProvider } = await import('./provider.ts');
    const p = new KimiProvider();
    expect(p.supportedAttachments()).toEqual({
      images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      documents: [],
    });
  });
});
