import { describe, expect, it } from 'vitest';

import { parseSSE, translateQuantStream, type QuantSSEEvent } from './stream.ts';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('parseSSE', () => {
  it('parses event+data pairs separated by blank lines and JSON-decodes data', async () => {
    const raw = [
      'id: c0\n',
      'event: start\n',
      'data: {"requestId":"r1","model":"m"}\n',
      '\n',
      'id: c1\n',
      'event: content\n',
      'data: {"delta":"hi"}\n',
      '\n',
    ];
    const out = await collect(parseSSE(fromArray(raw)));
    expect(out).toEqual([
      { event: 'start', data: { requestId: 'r1', model: 'm' } },
      { event: 'content', data: { delta: 'hi' } },
    ]);
  });

  it('handles events that span chunk boundaries', async () => {
    const raw = [
      'event: start\n',
      'data: {"reque',
      'stId":"r1","model":"m"}\n\nevent: cont',
      'ent\ndata: {"delta":"x"}\n\n',
    ];
    const out = await collect(parseSSE(fromArray(raw)));
    expect(out).toEqual([
      { event: 'start', data: { requestId: 'r1', model: 'm' } },
      { event: 'content', data: { delta: 'x' } },
    ]);
  });

  it('accepts Buffer chunks as well as strings', async () => {
    const raw = [
      Buffer.from('event: start\n'),
      Buffer.from('data: {"requestId":"r1","model":"m"}\n\n'),
    ];
    const out = await collect(parseSSE(fromArray(raw)));
    expect(out).toEqual([{ event: 'start', data: { requestId: 'r1', model: 'm' } }]);
  });

  it('defaults event to "message" when only data: is present', async () => {
    const raw = ['data: {"x":1}\n\n'];
    const out = await collect(parseSSE(fromArray(raw)));
    expect(out).toEqual([{ event: 'message', data: { x: 1 } }]);
  });
});

describe('translateQuantStream', () => {
  it('emits a tool_use content block from event=tool_request with the full input, indexed after any open text block', async () => {
    const events: QuantSSEEvent[] = [
      { event: 'start', data: { requestId: 'r2', model: 'm' } },
      { event: 'content', data: { delta: "I'll write a note." } },
      {
        event: 'tool_request',
        data: { toolUseId: 'toolu_1', name: 'write_memory', input: { body: 'b' } },
      },
      {
        event: 'done',
        data: { stopReason: 'tool_request', usage: { inputTokens: 5, outputTokens: 6 } },
      },
    ];
    const out = await collect(translateQuantStream(fromArray(events)));
    expect(out).toEqual([
      { type: 'message_start', id: 'r2', model: 'm' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll write a note." } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_memory', input: { body: 'b' } },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 5, output_tokens: 6 },
      },
      { type: 'message_stop' },
    ]);
  });

  it('ignores cloud auto-execute tool_start/tool_complete events (server-side tools praxis does not run)', async () => {
    const events: QuantSSEEvent[] = [
      { event: 'start', data: { requestId: 'r3', model: 'm' } },
      { event: 'content', data: { delta: 'one moment...' } },
      { event: 'tool_start', data: { name: 'cloud_tool', toolUseId: 'srv_1' } },
      { event: 'tool_complete', data: { name: 'cloud_tool', toolUseId: 'srv_1', result: { ok: true } } },
      { event: 'content', data: { delta: ' done.' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ];
    const out = await collect(translateQuantStream(fromArray(events)));
    expect(out).toEqual([
      { type: 'message_start', id: 'r3', model: 'm' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one moment...' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  });

  it('emits message_start from event=start, content_block events from text deltas, and a clean message_stop', async () => {
    const events: QuantSSEEvent[] = [
      { event: 'start', data: { requestId: 'r1', model: 'claude-sonnet-4-6', streaming: true } },
      { event: 'content', data: { delta: 'Hello ', complete: false } },
      { event: 'content', data: { delta: 'world.', complete: false } },
      {
        event: 'done',
        data: { stopReason: 'end_turn', complete: true, usage: { input_tokens: 4, output_tokens: 3 } },
      },
    ];
    const out = await collect(translateQuantStream(fromArray(events)));
    expect(out).toEqual([
      { type: 'message_start', id: 'r1', model: 'claude-sonnet-4-6' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 4, output_tokens: 3 },
      },
      { type: 'message_stop' },
    ]);
  });
});
