import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createSpy = vi.fn();
const streamSpy = vi.fn();
const constructorSpy = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class Anthropic {
    messages: { create: typeof createSpy; stream: typeof streamSpy };
    constructor(opts: unknown) {
      constructorSpy(opts);
      this.messages = { create: createSpy, stream: streamSpy };
    }
    static APIError = APIError;
  }
  return { default: Anthropic, APIError };
});

let prevKey: string | undefined;

beforeEach(() => {
  createSpy.mockReset();
  streamSpy.mockReset();
  constructorSpy.mockReset();
  prevKey = process.env['ANTHROPIC_API_KEY'];
});

afterEach(() => {
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
});

describe('AnthropicProvider.createMessage', () => {
  it('forwards system, messages, tools, and max_tokens to the SDK', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi back' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    const res = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });

    expect(res).toEqual({
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi back' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
      raw: expect.anything(),
    });
    expect(createSpy).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(constructorSpy).toHaveBeenCalledWith({ apiKey: 'sk-test' });
  });

  it('throws InferenceError(code=auth) when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { AnthropicProvider, InferenceError } = await import('../index.ts');
    const err = (() => {
      try {
        new AnthropicProvider();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as InstanceType<typeof InferenceError>).code).toBe('auth');
  });

  it('includes tools and forwards their schema when provided', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'm', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    await provider.createMessage({
      model: 'claude-sonnet-4-6',
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
          name: 'write_memory',
          description: 'persist a note',
          input_schema: { type: 'object', properties: { body: { type: 'string' } } },
        },
      ],
    });
  });

  it('does not set tools when the tools array is empty or absent', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'm', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      tools: [],
    });
    expect(createSpy.mock.calls[0]![0]).not.toHaveProperty('tools');
  });

  it('wraps Anthropic.APIError in InferenceError with code mapped from status', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const sdk = await import('@anthropic-ai/sdk');
    const APIError = (sdk.default as unknown as { APIError: new (m: string, s: number) => Error }).APIError;
    createSpy.mockRejectedValueOnce(new APIError('rate limited', 429));
    const { AnthropicProvider, InferenceError } = await import('../index.ts');
    const provider = new AnthropicProvider();
    const err = await provider
      .createMessage({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as InstanceType<typeof InferenceError>).code).toBe('rate_limit');
    expect((err as Error).message).toMatch(/429/);
  });

  it('defaults stop_reason to end_turn when the SDK returns null', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'm', model: 'claude-sonnet-4-6', content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    const res = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    });
    expect(res.stop_reason).toBe('end_turn');
  });

  it('translates SDK stream events into neutral StreamEvent shape', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    // Anthropic SDK's raw event shape: { type: 'message_start', message: {id, model, ...} }
    // and the rest mirror our neutral shape.
    const sdkEvents = [
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 4, output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    streamSpy.mockReturnValue({
      // Anthropic SDK's MessageStream is async-iterable
      [Symbol.asyncIterator]: async function* () {
        for (const e of sdkEvents) yield e;
      },
    });

    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    const collected: unknown[] = [];
    for await (const ev of provider.streamMessage!({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    })) {
      collected.push(ev);
    }

    expect(collected).toEqual([
      { type: 'message_start', id: 'msg_1', model: 'claude-sonnet-4-6' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 4, output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]);
    expect(streamSpy).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
    }));
  });

  it('forwards temperature and stop_sequences when set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'm', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      temperature: 0.3,
      stop_sequences: ['END'],
    });
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      temperature: 0.3,
      stop_sequences: ['END'],
    });
  });
});
