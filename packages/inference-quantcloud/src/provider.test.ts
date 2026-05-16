import { describe, expect, it, vi } from 'vitest';

describe('QuantCloudProvider.createMessage', () => {
  it('forwards a basic text request to AIInferenceApi.chatInference with the org and translated body', async () => {
    const chatInference = vi.fn().mockResolvedValue({
      data: {
        requestId: 'r1',
        model: 'anthropic.claude-sonnet-4-6-v1:0',
        response: { role: 'assistant', content: 'hi back' },
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    });
    const fakeApi = { chatInference } as unknown;

    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: fakeApi as never,
      organisation: 'org_123',
      defaultModelId: 'anthropic.claude-sonnet-4-6-v1:0',
      preferStreaming: false,
    });

    const res = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    });

    expect(res.content).toEqual([{ type: 'text', text: 'hi back' }]);
    expect(res.stop_reason).toBe('end_turn');
    expect(chatInference).toHaveBeenCalledTimes(1);
    expect(chatInference).toHaveBeenCalledWith('org_123', {
      modelId: 'anthropic.claude-sonnet-4-6-v1:0',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      maxTokens: 100,
    });
  });

  it('createMessage defaults to streaming-aggregate (streaming endpoint for token UX)', async () => {
    const chatInference = vi.fn(); // should NOT be called
    const chatInferenceStream = vi.fn().mockResolvedValue({
      data: {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('event: start\ndata: {"requestId":"r1","model":"m"}\n\n');
          yield Buffer.from('event: content\ndata: {"delta":"hi"}\n\n');
          yield Buffer.from(
            'event: done\ndata: {"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}}\n\n',
          );
        },
      },
    });
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference, chatInferenceStream } as never,
      organisation: 'org_123',
    });
    const res = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    });
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(res.stop_reason).toBe('end_turn');
    expect(res.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
    expect(chatInferenceStream).toHaveBeenCalledTimes(1);
    expect(chatInference).not.toHaveBeenCalled();
  });

  it('wraps SDK rejections in InferenceError, mapping HTTP 429 to code=rate_limit', async () => {
    const apiError = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
      isAxiosError: true,
    });
    const chatInference = vi.fn().mockRejectedValue(apiError);
    const fakeApi = { chatInference } as unknown;
    const { QuantCloudProvider } = await import('./provider.ts');
    const { InferenceError } = await import('@praxis-framework/inference');
    const provider = new QuantCloudProvider({
      inferenceApi: fakeApi as never,
      organisation: 'org_123',
      preferStreaming: false,
    });
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

  it('forwards toolConfig and translates tool_use + tool_result blocks across a multi-turn loop', async () => {
    const chatInference = vi.fn();
    // Turn 1: model emits tool_use.
    chatInference.mockResolvedValueOnce({
      data: {
        requestId: 'r1',
        model: 'm',
        response: {
          role: 'assistant',
          toolUse: { toolUseId: 'toolu_1', name: 'write_memory', input: { body: 'b' } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    // Turn 2: model finishes.
    chatInference.mockResolvedValueOnce({
      data: {
        requestId: 'r2',
        model: 'm',
        response: { role: 'assistant', content: 'done.' },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference } as never,
      organisation: 'org_123',
      preferStreaming: false,
    });

    const first = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'remember this' }],
      max_tokens: 100,
      tools: [
        {
          name: 'write_memory',
          description: 'persist a note',
          input_schema: { type: 'object', properties: { body: { type: 'string' } } },
        },
      ],
    });

    expect(first.stop_reason).toBe('tool_use');
    expect(first.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'write_memory', input: { body: 'b' } },
    ]);

    // First-call body must carry toolConfig in Bedrock toolSpec shape.
    expect(chatInference.mock.calls[0]![1]).toMatchObject({
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'write_memory',
              description: 'persist a note',
              inputSchema: { json: { type: 'object', properties: { body: { type: 'string' } } } },
            },
          },
        ],
      },
    });

    // Simulate the tool loop: send the assistant turn + a tool_result back.
    const second = await provider.createMessage({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'remember this' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'write_memory', input: { body: 'b' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'wrote it.' },
          ],
        },
      ],
      max_tokens: 100,
    });

    expect(second.content).toEqual([{ type: 'text', text: 'done.' }]);
    expect(second.stop_reason).toBe('end_turn');

    // Second-call body must carry the assistant tool_use + user tool_result as Bedrock blocks.
    const secondMessages = (chatInference.mock.calls[1]![1] as { messages: unknown[] }).messages;
    expect(secondMessages).toEqual([
      { role: 'user', content: [{ text: 'remember this' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'toolu_1', name: 'write_memory', input: { body: 'b' } } }],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'toolu_1',
              content: [{ text: 'wrote it.' }],
              status: 'success',
            },
          },
        ],
      },
    ]);
  });

  it('maps Anthropic-style model names to Quant Bedrock-style ids', async () => {
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference: vi.fn() } as never,
      organisation: 'org_123',
    });
    expect(provider.resolveModel('claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
    expect(provider.resolveModel('claude-opus-4-7')).toBe('anthropic.claude-opus-4-7');
    expect(provider.resolveModel('claude-haiku-4-5')).toBe(
      'anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('passes through model ids that are already Quant Bedrock-style', async () => {
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference: vi.fn() } as never,
      organisation: 'org_123',
    });
    expect(provider.resolveModel('anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
    expect(provider.resolveModel('amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
    // Unknown ids pass through untouched — Quant validates them server-side.
    expect(provider.resolveModel('some-future-model')).toBe('some-future-model');
  });

  it('defaultModelId overrides the model map', async () => {
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference: vi.fn() } as never,
      organisation: 'org_123',
      defaultModelId: 'amazon.nova-pro-v1:0',
    });
    expect(provider.resolveModel('claude-sonnet-4-6')).toBe('amazon.nova-pro-v1:0');
  });

  it('resolves logical model names through defaultModelId override', async () => {
    const chatInference = vi.fn().mockResolvedValue({
      data: {
        requestId: 'r',
        model: 'anthropic.claude-opus-4-7-v1:0',
        response: { role: 'assistant', content: 'ok' },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: { chatInference } as never,
      organisation: 'org_123',
      defaultModelId: 'anthropic.claude-opus-4-7-v1:0',
      preferStreaming: false,
    });
    await provider.createMessage({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    });
    expect(chatInference.mock.calls[0]![1]).toMatchObject({
      modelId: 'anthropic.claude-opus-4-7-v1:0',
    });
  });

  it('throws InferenceError(code=auth) when constructed without a token in env or opts', async () => {
    const prevToken = process.env['QUANT_API_TOKEN'];
    const prevOrg = process.env['QUANT_ORGANISATION'];
    delete process.env['QUANT_API_TOKEN'];
    delete process.env['QUANT_ORGANISATION'];
    try {
      const { QuantCloudProvider } = await import('./provider.ts');
      const { InferenceError } = await import('@praxis-framework/inference');
      const err = (() => {
        try {
          new QuantCloudProvider();
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(InferenceError);
      expect((err as InstanceType<typeof InferenceError>).code).toBe('auth');
    } finally {
      if (prevToken !== undefined) process.env['QUANT_API_TOKEN'] = prevToken;
      if (prevOrg !== undefined) process.env['QUANT_ORGANISATION'] = prevOrg;
    }
  });

  it('streamMessage parses SSE chunks from chatInferenceStream into neutral StreamEvents', async () => {
    const chatInferenceStream = vi.fn().mockResolvedValue({
      data: {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('event: start\ndata: {"requestId":"r1","model":"m"}\n\n');
          yield Buffer.from('event: content\ndata: {"delta":"hi"}\n\n');
          yield Buffer.from(
            'event: done\ndata: {"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":1}}\n\n',
          );
        },
      },
    });
    const fakeApi = { chatInferenceStream } as unknown;
    const { QuantCloudProvider } = await import('./provider.ts');
    const provider = new QuantCloudProvider({
      inferenceApi: fakeApi as never,
      organisation: 'org_123',
    });
    const collected: unknown[] = [];
    for await (const ev of provider.streamMessage!({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
    })) {
      collected.push(ev);
    }
    expect(collected).toEqual([
      { type: 'message_start', id: 'r1', model: 'm' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
    expect(chatInferenceStream).toHaveBeenCalledTimes(1);
    expect(chatInferenceStream.mock.calls[0]![1]).toMatchObject({
      modelId: 'anthropic.claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      stream: true,
    });
    // Asserts we asked the SDK for a raw stream rather than a parsed object.
    expect(chatInferenceStream.mock.calls[0]![2]).toMatchObject({ responseType: 'stream' });
  });

  it('throws InferenceError(code=auth) when an injected api is provided but organisation is missing', async () => {
    const prevOrg = process.env['QUANT_ORGANISATION'];
    delete process.env['QUANT_ORGANISATION'];
    try {
      const { QuantCloudProvider } = await import('./provider.ts');
      const { InferenceError } = await import('@praxis-framework/inference');
      const err = (() => {
        try {
          new QuantCloudProvider({ inferenceApi: { chatInference: vi.fn() } as never });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(InferenceError);
      expect((err as InstanceType<typeof InferenceError>).code).toBe('auth');
    } finally {
      if (prevOrg !== undefined) process.env['QUANT_ORGANISATION'] = prevOrg;
    }
  });
});
