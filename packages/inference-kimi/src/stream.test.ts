import { describe, expect, it } from 'vitest';

import type { StreamEvent } from '@praxis-framework/inference';
import type OpenAI from 'openai';

import { translateKimiStream } from './stream.ts';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

type Chunk = OpenAI.Chat.ChatCompletionChunk;

function makeChunk(partial: Partial<Chunk>): Chunk {
  return {
    id: 'chatcmpl-1',
    model: 'moonshot-v1-8k',
    created: 0,
    object: 'chat.completion.chunk',
    choices: [],
    ...partial,
  } as unknown as Chunk;
}

describe('translateKimiStream', () => {
  it('emits message_start on the first chunk with an id', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        id: 'chatcmpl-test',
        model: 'moonshot-v1-8k',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    expect(events[0]).toEqual({
      type: 'message_start',
      id: 'chatcmpl-test',
      model: 'moonshot-v1-8k',
    });
  });

  it('translates text deltas to content_block_start + content_block_delta events', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    // Find the content_block_start event.
    const blockStart = events.find((e) => e.type === 'content_block_start');
    expect(blockStart).toMatchObject({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });

    const deltas = events.filter(
      (e): e is Extract<StreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    });
    expect(deltas[1]).toMatchObject({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    });
  });

  it('emits content_block_stop, message_delta, and message_stop at the end', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    const types = events.map((e) => e.type);
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types).toContain('message_stop');
    // message_stop must be last.
    expect(types[types.length - 1]).toBe('message_stop');
  });

  it('maps finish_reason=stop to stop_reason=end_turn in message_delta', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    const delta = events.find(
      (e): e is Extract<StreamEvent, { type: 'message_delta' }> =>
        e.type === 'message_delta',
    );
    expect(delta?.delta.stop_reason).toBe('end_turn');
  });

  it('maps finish_reason=tool_calls to stop_reason=tool_use in message_delta', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"test"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    const delta = events.find(
      (e): e is Extract<StreamEvent, { type: 'message_delta' }> =>
        e.type === 'message_delta',
    );
    expect(delta?.delta.stop_reason).toBe('tool_use');
  });

  it('translates tool-call chunks to content_block_start + input_json_delta events', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'write_memory', arguments: '{"bo' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: undefined,
                  type: 'function',
                  function: { name: '', arguments: 'dy":"x"}' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls', logprobs: null }],
      }),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));

    // A content_block_start for the tool call at index 1 (0 is text).
    const blockStart = events.find(
      (e): e is Extract<StreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start' &&
        (e as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
    );
    expect(blockStart).toBeDefined();
    expect(blockStart?.content_block).toMatchObject({
      type: 'tool_use',
      id: 'call_abc',
      name: 'write_memory',
    });

    const jsonDeltas = events.filter(
      (e): e is Extract<StreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta' &&
        (e as { delta?: { type?: string } }).delta?.type === 'input_json_delta',
    );
    expect(jsonDeltas).toHaveLength(2);
    expect(jsonDeltas[0]?.delta).toEqual({ type: 'input_json_delta', partial_json: '{"bo' });
    expect(jsonDeltas[1]?.delta).toEqual({ type: 'input_json_delta', partial_json: 'dy":"x"}' });
  });

  it('handles usage data from a trailing chunk with no choices', async () => {
    const chunks: Chunk[] = [
      makeChunk({
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null, logprobs: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      }),
      makeChunk({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      } as unknown as Chunk),
    ];
    const events = await collect(translateKimiStream(fromArray(chunks)));
    const delta = events.find(
      (e): e is Extract<StreamEvent, { type: 'message_delta' }> =>
        e.type === 'message_delta',
    );
    expect(delta?.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });
});
