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
    expect(createSpy.mock.calls[0]![0]).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // No signal supplied — the SDK gets `undefined` for options.
    expect(createSpy.mock.calls[0]![1]).toBeUndefined();
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
    expect(streamSpy.mock.calls[0]![0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
    });
    // No signal supplied — the SDK gets `undefined` for options.
    expect(streamSpy.mock.calls[0]![1]).toBeUndefined();
  });

  it('throws InferenceError immediately when createMessage is called with an already-aborted signal', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const { AnthropicProvider, InferenceError } = await import('../index.ts');
    const provider = new AnthropicProvider();
    const controller = new AbortController();
    controller.abort();
    const err = await provider
      .createMessage(
        {
          model: 'claude-sonnet-4-6',
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

  it('forwards the AbortSignal to the SDK request options when createMessage is called', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      id: 'm',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { AnthropicProvider } = await import('./anthropic.ts');
    const provider = new AnthropicProvider();
    const controller = new AbortController();
    await provider.createMessage(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      },
      controller.signal,
    );
    expect(createSpy.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });

  it('throws InferenceError immediately when streamMessage is called with an already-aborted signal', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const { AnthropicProvider, InferenceError } = await import('../index.ts');
    const provider = new AnthropicProvider();
    const controller = new AbortController();
    controller.abort();
    const err = await (async () => {
      try {
        for await (const _ev of provider.streamMessage!(
          {
            model: 'claude-sonnet-4-6',
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
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('stops yielding stream events and throws when the signal aborts mid-stream', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const controller = new AbortController();
    const sdkEvents = [
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      // After this event we abort — subsequent events must not be yielded.
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
      { type: 'message_stop' },
    ];
    streamSpy.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const e of sdkEvents) yield e;
      },
    });

    const { AnthropicProvider, InferenceError } = await import('../index.ts');
    const provider = new AnthropicProvider();
    const collected: unknown[] = [];
    const run = async () => {
      for await (const ev of provider.streamMessage!(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 50,
        },
        controller.signal,
      )) {
        collected.push(ev);
        if (collected.length === 3) controller.abort();
      }
    };
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InferenceError);
    expect((err as Error).message).toMatch(/aborted/);
    // We yielded 3 events before aborting — no events should follow.
    expect(collected).toHaveLength(3);
    // Confirm the signal was passed through to the SDK call too.
    expect(streamSpy.mock.calls[0]![1]).toEqual({ signal: controller.signal });
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

  describe('has(capability)', () => {
    const prev = process.env['ANTHROPIC_API_KEY'];

    beforeEach(() => {
      delete process.env['ANTHROPIC_API_KEY'];
    });

    afterEach(() => {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    });

    it('returns true for all capabilities when api key is present', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      const { AnthropicProvider } = await import('./anthropic.ts');
      const p = new AnthropicProvider();
      expect(p.has('chat')).toBe(true);
      expect(p.has('streaming')).toBe(true);
      expect(p.has('tools')).toBe(true);
    });

    it('returns true via apiKey constructor option without env var', async () => {
      const { AnthropicProvider } = await import('./anthropic.ts');
      const p = new AnthropicProvider({ apiKey: 'sk-test' });
      expect(p.has('chat')).toBe(true);
    });

    it('returns true via client injection (testing seam)', async () => {
      const { AnthropicProvider } = await import('./anthropic.ts');
      // When a pre-built client is injected, we trust the caller has auth set up.
      const fakeClient = {} as unknown as NonNullable<
        ConstructorParameters<typeof AnthropicProvider>[0]
      >['client'];
      const p = new AnthropicProvider({ client: fakeClient });
      expect(p.has('chat')).toBe(true);
    });
  });

  describe('supportedAttachments()', () => {
    it('reports the native image and document MIME types', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      const { AnthropicProvider } = await import('./anthropic.ts');
      const p = new AnthropicProvider();
      expect(p.supportedAttachments()).toEqual({
        images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
        documents: ['application/pdf'],
      });
    });
  });
});

describe('toAnthropicMessages', () => {
  it('rewrites a document block name to the SDK title field and drops name', async () => {
    const { toAnthropicMessages } = await import('./anthropic.ts');
    const out = toAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'review this' },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
            name: 'spec.pdf',
          },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'review this' },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
            title: 'spec.pdf',
          },
        ],
      },
    ]);
    // The neutral `name` field must not survive into the SDK shape.
    const doc = (out[0]!.content as unknown[])[1] as Record<string, unknown>;
    expect(doc).not.toHaveProperty('name');
  });

  it('omits title when the document block has no name', async () => {
    const { toAnthropicMessages } = await import('./anthropic.ts');
    const out = toAnthropicMessages([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
          },
        ],
      },
    ]);
    const doc = (out[0]!.content as unknown[])[0] as Record<string, unknown>;
    expect(doc).not.toHaveProperty('title');
    expect(doc).not.toHaveProperty('name');
  });

  it('leaves other block types and string content untouched', async () => {
    const { toAnthropicMessages } = await import('./anthropic.ts');
    const input = [
      { role: 'user' as const, content: 'plain string' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'reply' },
          {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/png', data: 'BBBB' },
          },
        ],
      },
    ];
    expect(toAnthropicMessages(input)).toEqual(input);
  });
});
