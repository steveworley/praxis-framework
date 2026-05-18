import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Turn } from './conversation.ts';

const createSpy = vi.fn();
const streamSpy = vi.fn();

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
    constructor() {
      this.messages = { create: createSpy, stream: streamSpy };
    }
    static APIError = APIError;
  }
  return { default: Anthropic, APIError };
});

let prevKey: string | undefined;
let prevProvider: string | undefined;

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

beforeEach(() => {
  createSpy.mockReset();
  streamSpy.mockReset();
  prevKey = process.env['ANTHROPIC_API_KEY'];
  prevProvider = process.env['PRAXIS_INFERENCE_PROVIDER'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
});

afterEach(() => {
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  if (prevProvider === undefined) delete process.env['PRAXIS_INFERENCE_PROVIDER'];
  else process.env['PRAXIS_INFERENCE_PROVIDER'] = prevProvider;
});

describe('streamMessageWithTools', () => {
  it('yields inference_event for each SDK stream event then a complete event with the final text', async () => {
    streamSpy.mockReturnValueOnce(
      asyncIterable([
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'op' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 3, output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]),
    );

    const { streamMessageWithTools, resetProviderForTesting } = await import('./anthropic.ts');
    resetProviderForTesting();

    const turns: Turn[] = [];
    const events: unknown[] = [];
    for await (const ev of streamMessageWithTools('sys', turns, 'hi', [], async () => ({
      ok: false,
      contentText: 'no tools',
    }))) {
      events.push(ev);
    }
    const last = events[events.length - 1] as { type: string; result: { text: string; toolCalls: unknown[]; truncated: boolean } };
    expect(last.type).toBe('complete');
    expect(last.result.text).toBe('hi op');
    expect(last.result.toolCalls).toEqual([]);
    expect(last.result.truncated).toBe(false);

    // We saw the inference events flow through.
    const inferenceEvents = events.filter(
      (e): e is { type: 'inference_event' } => (e as { type: string }).type === 'inference_event',
    );
    expect(inferenceEvents.length).toBeGreaterThan(0);
  });

  it('executes tools across iterations and yields tool_start + tool_complete events between them', async () => {
    // Iteration 1: model emits a tool_use.
    streamSpy.mockReturnValueOnce(
      asyncIterable([
        { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-4-6' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_memory', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"body":"hi"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 2 } },
        { type: 'message_stop' },
      ]),
    );
    // Iteration 2: model finishes.
    streamSpy.mockReturnValueOnce(
      asyncIterable([
        { type: 'message_start', message: { id: 'm2', model: 'claude-sonnet-4-6' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4, output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );

    const exec = vi.fn().mockResolvedValue({
      ok: true,
      contentText: 'wrote memory/notes/x.md.',
      summary: 'wrote it',
    });
    const { streamMessageWithTools, resetProviderForTesting } = await import('./anthropic.ts');
    resetProviderForTesting();

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const ev of streamMessageWithTools(
      'sys',
      [],
      'remember this',
      [{ name: 'write_memory', input_schema: { type: 'object' } }],
      exec,
    )) {
      events.push(ev as { type: string; [k: string]: unknown });
    }

    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolComplete = events.find((e) => e.type === 'tool_complete');
    const complete = events.find((e) => e.type === 'complete') as
      | { type: 'complete'; result: { text: string; toolCalls: Array<{ name: string; result: { ok: boolean } }>; truncated: boolean } }
      | undefined;

    expect(toolStart).toBeDefined();
    expect(toolStart).toMatchObject({ type: 'tool_start', name: 'write_memory' });
    expect(toolComplete).toBeDefined();
    expect(toolComplete).toMatchObject({ type: 'tool_complete', name: 'write_memory' });
    expect(complete?.result.text).toBe('Done.');
    expect(complete?.result.toolCalls).toHaveLength(1);
    expect(complete?.result.toolCalls[0]!.name).toBe('write_memory');
    expect(complete?.result.toolCalls[0]!.result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('write_memory', { body: 'hi' });
  });
});
