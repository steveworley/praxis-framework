import { describe, expect, it } from 'vitest';

import { aggregateStream } from './aggregate.ts';
import type { StreamEvent } from './types.ts';

async function* fromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('aggregateStream', () => {
  it('reconstructs interleaved text + tool_use, concatenating input_json_delta fragments', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', id: 'msg_2', model: 'claude-sonnet-4-6' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will write a note. ' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_memory', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cat' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'egory":"notes","body":"hi"}' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 7, output_tokens: 4 },
      },
      { type: 'message_stop' },
    ];

    const res = await aggregateStream(fromArray(events));

    expect(res.content).toEqual([
      { type: 'text', text: 'I will write a note. ' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'write_memory',
        input: { category: 'notes', body: 'hi' },
      },
    ]);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.usage).toEqual({ input_tokens: 7, output_tokens: 4 });
  });

  it('keeps tool_use input supplied directly on content_block_start when no input_json_delta follows', async () => {
    // Quant's translator delivers the full tool input upfront (from a tool_request
    // event) rather than streaming input_json_delta fragments.
    const events: StreamEvent[] = [
      { type: 'message_start', id: 'msg_q', model: 'claude-sonnet-4-6' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_q',
          name: 'get_weather',
          input: { location: 'Sydney' },
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 9, output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    const res = await aggregateStream(fromArray(events));
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'toolu_q', name: 'get_weather', input: { location: 'Sydney' } },
    ]);
    expect(res.stop_reason).toBe('tool_use');
  });

  it('falls back to raw string when tool_use input fragments are not valid JSON', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', id: 'msg_3', model: 'claude-sonnet-4-6' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'noop', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const res = await aggregateStream(fromArray(events));
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'toolu_x', name: 'noop', input: 'not-json' },
    ]);
  });

  it('reconstructs a text-only response with usage and stop_reason', async () => {
    const events: StreamEvent[] = [
      { type: 'message_start', id: 'msg_1', model: 'claude-sonnet-4-6' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      { type: 'message_stop' },
    ];

    const res = await aggregateStream(fromArray(events));

    expect(res.id).toBe('msg_1');
    expect(res.model).toBe('claude-sonnet-4-6');
    expect(res.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(res.stop_reason).toBe('end_turn');
    expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });
});
