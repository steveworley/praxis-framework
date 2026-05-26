import { describe, expect, it } from 'vitest';

import type { ContentBlock, Message, ToolDef } from '@praxis-framework/inference';

import {
  fromQuantResponse,
  stringifySystem,
  toBedrockBlock,
  toBedrockMessage,
  toBedrockToolSpec,
} from './translate.ts';

describe('fromQuantResponse', () => {
  it('returns a single text content block when only text is present', () => {
    const out = fromQuantResponse({
      requestId: 'r1',
      model: 'claude-sonnet',
      response: { role: 'assistant', content: 'hello operator' },
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(out.content).toEqual([{ type: 'text', text: 'hello operator' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.id).toBe('r1');
    expect(out.model).toBe('claude-sonnet');
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it('emits a tool_use content block for a single tool use and sets stop_reason=tool_use', () => {
    const out = fromQuantResponse({
      requestId: 'r2',
      model: 'claude-sonnet',
      response: {
        role: 'assistant',
        toolUse: { toolUseId: 'toolu_a', name: 'write_memory', input: { body: 'b' } },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'toolu_a', name: 'write_memory', input: { body: 'b' } },
    ]);
  });

  it('emits multiple tool_use blocks when toolUse is an array', () => {
    const out = fromQuantResponse({
      requestId: 'r3',
      model: 'claude-sonnet',
      response: {
        role: 'assistant',
        content: 'thinking aloud',
        toolUse: [
          { toolUseId: 't1', name: 'write_memory', input: {} },
          { toolUseId: 't2', name: 'log_decision', input: {} },
        ],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'text', text: 'thinking aloud' },
      { type: 'tool_use', id: 't1', name: 'write_memory', input: {} },
      { type: 'tool_use', id: 't2', name: 'log_decision', input: {} },
    ]);
  });

  it('preserves the raw payload for diagnostics', () => {
    const json = {
      requestId: 'r4',
      model: 'claude-sonnet',
      response: { role: 'assistant' as const, content: 'x' },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = fromQuantResponse(json);
    expect(out.raw).toBe(json);
  });
});

describe('toBedrockBlock', () => {
  it('maps text', () => {
    expect(toBedrockBlock({ type: 'text', text: 'hello' })).toEqual({ text: 'hello' });
  });

  it('maps tool_use to Bedrock toolUse shape with toolUseId', () => {
    expect(
      toBedrockBlock({ type: 'tool_use', id: 'toolu_1', name: 'w', input: { a: 1 } }),
    ).toEqual({
      toolUse: { toolUseId: 'toolu_1', name: 'w', input: { a: 1 } },
    });
  });

  it('maps tool_result success with string content to a single text block + status=success', () => {
    expect(
      toBedrockBlock({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'wrote it.',
      }),
    ).toEqual({
      toolResult: { toolUseId: 'toolu_1', content: [{ text: 'wrote it.' }], status: 'success' },
    });
  });

  it('maps tool_result error with is_error=true to status=error', () => {
    expect(
      toBedrockBlock({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'already exists',
        is_error: true,
      }),
    ).toEqual({
      toolResult: {
        toolUseId: 'toolu_1',
        content: [{ text: 'already exists' }],
        status: 'error',
      },
    });
  });

  it('maps tool_result with structured content blocks recursively', () => {
    const inner: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(
      toBedrockBlock({ type: 'tool_result', tool_use_id: 'toolu_1', content: inner }),
    ).toEqual({
      toolResult: {
        toolUseId: 'toolu_1',
        content: [{ text: 'first' }, { text: 'second' }],
        status: 'success',
      },
    });
  });

  it('maps image to Bedrock image shape, stripping the image/ prefix from media_type', () => {
    expect(
      toBedrockBlock({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
      }),
    ).toEqual({ image: { format: 'jpeg', source: { bytes: 'AAAA' } } });
  });

  describe('document', () => {
    const cases: { mediaType: string; expectedFormat: string }[] = [
      { mediaType: 'application/pdf', expectedFormat: 'pdf' },
      {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expectedFormat: 'docx',
      },
      { mediaType: 'application/msword', expectedFormat: 'doc' },
      { mediaType: 'text/markdown', expectedFormat: 'md' },
      { mediaType: 'text/csv', expectedFormat: 'csv' },
      { mediaType: 'text/html', expectedFormat: 'html' },
      { mediaType: 'text/plain', expectedFormat: 'txt' },
    ];

    it.each(cases)(
      'maps $mediaType to format $expectedFormat',
      ({ mediaType, expectedFormat }) => {
        expect(
          toBedrockBlock({
            type: 'document',
            source: { type: 'base64', media_type: mediaType, data: 'AAAA' },
            // Name uses only Bedrock-allowed characters so it passes through.
            name: 'report 1',
          }),
        ).toEqual({
          document: {
            format: expectedFormat,
            name: 'report 1',
            source: { bytes: 'AAAA' },
          },
        });
      },
    );

    it('falls back to the substring after the slash for unmapped media types', () => {
      expect(
        toBedrockBlock({
          type: 'document',
          source: { type: 'base64', media_type: 'application/xyz', data: 'AAAA' },
          name: 'thing',
        }),
      ).toEqual({
        document: { format: 'xyz', name: 'thing', source: { bytes: 'AAAA' } },
      });
    });

    it('passes the base64 bytes through unchanged', () => {
      const out = toBedrockBlock({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'Zm9vYmFy' },
        name: 'doc one',
      });
      expect(out).toEqual({
        document: { format: 'pdf', name: 'doc one', source: { bytes: 'Zm9vYmFy' } },
      });
    });

    describe('name sanitisation', () => {
      const nameCases: { input: string | undefined; expected: string }[] = [
        // A dot is disallowed, so a typical filename extension becomes a space.
        { input: 'report.pdf', expected: 'report pdf' },
        // Disallowed characters become spaces and runs collapse.
        { input: 'my/weird:file*name.pdf', expected: 'my weird file name pdf' },
        // Allowed punctuation is preserved.
        { input: 'Report (v2) [final].pdf', expected: 'Report (v2) [final] pdf' },
        // Leading/trailing disallowed chars are trimmed.
        { input: '___notes___', expected: 'notes' },
        // Empty after sanitising falls back to `document`.
        { input: '***', expected: 'document' },
        { input: '', expected: 'document' },
        // Missing name falls back to `document`.
        { input: undefined, expected: 'document' },
      ];

      it.each(nameCases)(
        'sanitises $input to "$expected"',
        ({ input, expected }) => {
          const out = toBedrockBlock({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
            ...(input !== undefined ? { name: input } : {}),
          });
          expect(out).toEqual({
            document: { format: 'pdf', name: expected, source: { bytes: 'AAAA' } },
          });
        },
      );
    });
  });
});

describe('toBedrockMessage', () => {
  it('wraps a string content in a single text block', () => {
    expect(toBedrockMessage({ role: 'user', content: 'hi' })).toEqual({
      role: 'user',
      content: [{ text: 'hi' }],
    });
  });

  it('maps an array content through toBedrockBlock', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply' },
        { type: 'tool_use', id: 't1', name: 'w', input: {} },
      ],
    };
    expect(toBedrockMessage(msg)).toEqual({
      role: 'assistant',
      content: [{ text: 'reply' }, { toolUse: { toolUseId: 't1', name: 'w', input: {} } }],
    });
  });
});

describe('toBedrockToolSpec', () => {
  it('wraps a tool definition into toolSpec with inputSchema.json', () => {
    const tool: ToolDef = {
      name: 'write_memory',
      description: 'persist a note',
      input_schema: { type: 'object', properties: { body: { type: 'string' } } },
    };
    expect(toBedrockToolSpec(tool)).toEqual({
      toolSpec: {
        name: 'write_memory',
        description: 'persist a note',
        inputSchema: {
          json: { type: 'object', properties: { body: { type: 'string' } } },
        },
      },
    });
  });

  it('omits description when undefined', () => {
    const tool: ToolDef = { name: 'noop', input_schema: { type: 'object' } };
    const out = toBedrockToolSpec(tool);
    expect(out.toolSpec).not.toHaveProperty('description');
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
    expect(
      stringifySystem([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });
});
