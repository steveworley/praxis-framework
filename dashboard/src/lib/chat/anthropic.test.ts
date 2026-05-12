import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Turn } from './conversation.ts';

// Capture the constructor arguments + messages.create calls per test.
const createSpy = vi.fn();
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
    messages: { create: typeof createSpy };
    constructor(opts: unknown) {
      constructorSpy(opts);
      this.messages = { create: createSpy };
    }
    static APIError = APIError;
  }
  return { default: Anthropic, APIError };
});

let prevKey: string | undefined;
let prevModel: string | undefined;

beforeEach(() => {
  createSpy.mockReset();
  constructorSpy.mockReset();
  prevKey = process.env['ANTHROPIC_API_KEY'];
  prevModel = process.env['PRAXIS_CHAT_MODEL'];
});

afterEach(() => {
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  if (prevModel === undefined) delete process.env['PRAXIS_CHAT_MODEL'];
  else process.env['PRAXIS_CHAT_MODEL'] = prevModel;
});

describe('hasApiKey + resolveChatModel', () => {
  it('reports false when the env var is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { hasApiKey } = await import('./anthropic.ts');
    expect(hasApiKey()).toBe(false);
  });

  it('reports true when the env var is set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const { hasApiKey } = await import('./anthropic.ts');
    expect(hasApiKey()).toBe(true);
  });

  it('defaults the chat model to claude-sonnet-4-6', async () => {
    delete process.env['PRAXIS_CHAT_MODEL'];
    const { resolveChatModel } = await import('./anthropic.ts');
    expect(resolveChatModel()).toBe('claude-sonnet-4-6');
  });

  it('reads PRAXIS_CHAT_MODEL when set', async () => {
    process.env['PRAXIS_CHAT_MODEL'] = 'claude-opus-4-7';
    const { resolveChatModel } = await import('./anthropic.ts');
    expect(resolveChatModel()).toBe('claude-opus-4-7');
  });
});

describe('buildMessages', () => {
  it('maps stored turns into MessageParam objects', async () => {
    const { buildMessages } = await import('./anthropic.ts');
    const turns: Turn[] = [
      { role: 'user', timestamp: 't1', content: 'hello' },
      { role: 'assistant', timestamp: 't2', content: 'hi' },
    ];
    expect(buildMessages(turns)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });
});

describe('sendMessage', () => {
  it('throws MissingApiKeyError when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { sendMessage, MissingApiKeyError } = await import('./anthropic.ts');
    await expect(sendMessage('sys', [], 'hi')).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it('sends the assembled messages array and returns the joined text response', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Hello operator.' },
        { type: 'text', text: ' Doing well.' },
      ],
    });
    const { sendMessage } = await import('./anthropic.ts');
    const turns: Turn[] = [
      { role: 'user', timestamp: 't1', content: 'first user' },
      { role: 'assistant', timestamp: 't2', content: 'first reply' },
    ];
    const text = await sendMessage('SYSTEM PROMPT', turns, 'second user');
    expect(text).toBe('Hello operator. Doing well.');
    expect(constructorSpy).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: 'SYSTEM PROMPT',
      messages: [
        { role: 'user', content: 'first user' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second user' },
      ],
    });
  });

  it('honours PRAXIS_CHAT_MODEL for the model field', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    process.env['PRAXIS_CHAT_MODEL'] = 'claude-opus-4-7';
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });
    const { sendMessage } = await import('./anthropic.ts');
    await sendMessage('sys', [], 'hi');
    expect(createSpy.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-4-7' });
  });

  it('wraps SDK errors in AnthropicChatError', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const sdk = await import('@anthropic-ai/sdk');
    const apiError = new (sdk.default as unknown as { APIError: new (m: string, s: number) => Error }).APIError(
      'rate limited',
      429,
    );
    createSpy.mockRejectedValue(apiError);
    const { sendMessage, AnthropicChatError } = await import('./anthropic.ts');
    const err = await sendMessage('sys', [], 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicChatError);
    expect((err as Error).message).toMatch(/429/);
  });
});

describe('sendMessageWithTools — tool-use loop', () => {
  it('returns immediately when stop_reason is end_turn', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello' }],
    });
    const { sendMessageWithTools } = await import('./anthropic.ts');
    const exec = vi.fn();
    const result = await sendMessageWithTools(
      'sys',
      [],
      'hi',
      [
        {
          name: 'noop',
          description: 'noop',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      exec,
    );
    expect(result.text).toBe('hello');
    expect(result.toolCalls).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('loops on tool_use stop_reason and feeds tool_result back', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: '' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'write_memory',
            input: { category: 'notes', title: 't', body: 'b' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
      });

    const exec = vi.fn().mockResolvedValue({
      ok: true,
      contentText: 'wrote memory/notes/t.md.\n{"path":"memory/notes/t.md"}',
      summary: 'wrote memory/notes/t.md',
      data: { path: 'memory/notes/t.md' },
    });

    const { sendMessageWithTools } = await import('./anthropic.ts');
    const result = await sendMessageWithTools(
      'sys',
      [],
      'remember this',
      [
        {
          name: 'write_memory',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      exec,
    );

    expect(result.text).toBe('Done.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('write_memory');
    expect(result.toolCalls[0]!.result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('write_memory', {
      category: 'notes',
      title: 't',
      body: 'b',
    });

    // Verify the second create call passed back the tool_result.
    const secondCall = createSpy.mock.calls[1]![0] as { messages: unknown[] };
    expect(secondCall.messages).toHaveLength(3); // user + assistant(tool_use) + user(tool_result)
    const lastMsg = secondCall.messages[2] as {
      role: string;
      content: Array<{ type: string; tool_use_id: string; is_error?: boolean }>;
    };
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content[0]!.type).toBe('tool_result');
    expect(lastMsg.content[0]!.tool_use_id).toBe('toolu_1');
    expect(lastMsg.content[0]!.is_error).toBe(false);
  });

  it('marks tool failures with is_error and persists the error in toolCalls', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_fail',
            name: 'write_memory',
            input: { category: 'people', title: 'dup', body: 'b' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'noted the refusal' }],
      });

    const exec = vi
      .fn()
      .mockResolvedValue({ ok: false, contentText: 'already exists' });

    const { sendMessageWithTools } = await import('./anthropic.ts');
    const result = await sendMessageWithTools('sys', [], 'try', [], exec);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.result.ok).toBe(false);
    expect(result.toolCalls[0]!.result.error).toBe('already exists');

    const secondCall = createSpy.mock.calls[1]![0] as { messages: unknown[] };
    const lastMsg = secondCall.messages[2] as {
      content: Array<{ is_error: boolean }>;
    };
    expect(lastMsg.content[0]!.is_error).toBe(true);
  });
});
