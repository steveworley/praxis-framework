import { describe, expect, it } from 'vitest';

import type { ContentBlock, Message, ToolDef } from '@praxis-framework/inference';

import {
  fromOpenAIResponse,
  mapFinishReason,
  stringifySystem,
  toOpenAIMessages,
  toOpenAITool,
} from './translate.ts';

describe('toOpenAIMessages', () => {
  it('converts a plain-string user message to OpenAI user shape', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    expect(toOpenAIMessages(msgs)).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('converts a plain-string assistant message to OpenAI assistant shape', () => {
    const msgs: Message[] = [{ role: 'assistant', content: 'hi back' }];
    expect(toOpenAIMessages(msgs)).toEqual([
      { role: 'assistant', content: 'hi back' },
    ]);
  });

  it('converts a user text block to an OpenAI text part', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    expect(toOpenAIMessages(msgs)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('converts a user image block to an image_url part with base64 data URL', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    ];
    expect(toOpenAIMessages(msgs)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('converts a user document block to an embedded text part', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
            name: 'report.pdf',
          },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out).toHaveLength(1);
    const msg = out[0];
    expect(msg?.role).toBe('user');
    // Should embed as text with doc context prefix.
    expect(
      Array.isArray(msg?.content) &&
        (msg.content as { type: string; text: string }[])[0]?.type,
    ).toBe('text');
  });

  it('converts an assistant message with tool_use blocks to tool_calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'call_1', name: 'write_memory', input: { body: 'x' } },
        ],
      },
    ];
    expect(toOpenAIMessages(msgs)).toEqual([
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'write_memory', arguments: '{"body":"x"}' },
          },
        ],
      },
    ]);
  });

  it('converts tool_result blocks to separate OpenAI tool messages', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'done',
          },
        ],
      },
    ];
    expect(toOpenAIMessages(msgs)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]);
  });

  it('converts tool_result with structured content blocks by joining text', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: [
              { type: 'text', text: 'part a' },
              { type: 'text', text: 'part b' },
            ],
          },
        ],
      },
    ];
    expect(toOpenAIMessages(msgs)).toEqual([
      { role: 'tool', tool_call_id: 'call_2', content: 'part apart b' },
    ]);
  });

  it('handles a multi-turn conversation with assistant tool use and tool result', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'use the tool' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_3', name: 'search', input: { q: 'test' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_3', content: 'result data' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'user', content: 'use the tool' });
    expect(out[1]).toMatchObject({ role: 'assistant', tool_calls: expect.any(Array) });
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'call_3', content: 'result data' });
  });
});

describe('toOpenAITool', () => {
  it('wraps a tool definition in the OpenAI function-calling shape', () => {
    const tool: ToolDef = {
      name: 'write_memory',
      description: 'persist a note',
      input_schema: { type: 'object', properties: { body: { type: 'string' } } },
    };
    expect(toOpenAITool(tool)).toEqual({
      type: 'function',
      function: {
        name: 'write_memory',
        description: 'persist a note',
        parameters: { type: 'object', properties: { body: { type: 'string' } } },
      },
    });
  });

  it('omits description when not provided', () => {
    const tool: ToolDef = { name: 'noop', input_schema: { type: 'object' } };
    const out = toOpenAITool(tool);
    expect(out.function).not.toHaveProperty('description');
  });
});

describe('fromOpenAIResponse', () => {
  it('returns a text content block when only text is present', () => {
    const res = {
      id: 'chatcmpl-1',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'hello', tool_calls: undefined },
          finish_reason: 'stop' as const,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      created: 0,
      object: 'chat.completion' as const,
    };
    const out = fromOpenAIResponse(res);
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.id).toBe('chatcmpl-1');
    expect(out.model).toBe('moonshot-v1-8k');
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it('returns tool_use content blocks when tool calls are present', () => {
    const res = {
      id: 'chatcmpl-2',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"q":"test"}' },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      created: 0,
      object: 'chat.completion' as const,
    };
    const out = fromOpenAIResponse(res);
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'call_abc', name: 'search', input: { q: 'test' } },
    ]);
  });

  it('handles malformed JSON in tool call arguments gracefully', () => {
    const res = {
      id: 'chatcmpl-3',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function' as const,
                function: { name: 'noop', arguments: 'NOT_JSON' },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion' as const,
    };
    const out = fromOpenAIResponse(res);
    expect(out.content[0]).toMatchObject({ type: 'tool_use', name: 'noop', input: 'NOT_JSON' });
  });

  it('preserves the raw response', () => {
    const res = {
      id: 'chatcmpl-4',
      model: 'moonshot-v1-8k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'ok', tool_calls: undefined },
          finish_reason: 'stop' as const,
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: 0,
      object: 'chat.completion' as const,
    };
    const out = fromOpenAIResponse(res);
    expect(out.raw).toBe(res);
  });
});

describe('mapFinishReason', () => {
  it('maps tool_calls to tool_use', () => {
    expect(mapFinishReason('tool_calls')).toBe('tool_use');
  });

  it('maps length to max_tokens', () => {
    expect(mapFinishReason('length')).toBe('max_tokens');
  });

  it('maps stop to end_turn', () => {
    expect(mapFinishReason('stop')).toBe('end_turn');
  });

  it('maps null to end_turn', () => {
    expect(mapFinishReason(null)).toBe('end_turn');
  });

  it('maps unknown values to end_turn', () => {
    expect(mapFinishReason('content_filter')).toBe('end_turn');
  });
});

describe('stringifySystem', () => {
  it('passes through strings', () => {
    expect(stringifySystem('hello')).toBe('hello');
  });

  it('returns undefined for undefined', () => {
    expect(stringifySystem(undefined)).toBeUndefined();
  });

  it('concatenates text blocks and ignores non-text variants', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    expect(stringifySystem(blocks)).toBe('ab');
  });
});
