import { describe, expect, it } from 'vitest';

import type { Turn } from './conversation.ts';
import { estimateThreadTokens, estimateTokens } from './tokens.ts';

describe('estimateTokens', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up to the nearest token for short strings', () => {
    // 1 char → ceil(1/4) = 1
    expect(estimateTokens('a')).toBe(1);
    // 4 chars → ceil(4/4) = 1
    expect(estimateTokens('abcd')).toBe(1);
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('approximates ~chars/4 for longer strings', () => {
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });

  it('matches the documented Math.ceil(len/4) shape on mixed prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'; // 44 chars
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});

describe('estimateThreadTokens', () => {
  it('zero turns + empty system prompt → 0', () => {
    expect(estimateThreadTokens([], '')).toEqual({
      systemPrompt: 0,
      history: 0,
      total: 0,
    });
  });

  it('sums the system prompt + every turn content', () => {
    const turns: Turn[] = [
      { role: 'user', timestamp: 't1', content: 'a'.repeat(40) }, // 10
      { role: 'assistant', timestamp: 't2', content: 'b'.repeat(80) }, // 20
      { role: 'user', timestamp: 't3', content: 'c'.repeat(120) }, // 30
    ];
    const systemPrompt = 'x'.repeat(200); // 50
    const result = estimateThreadTokens(turns, systemPrompt);
    expect(result.systemPrompt).toBe(50);
    expect(result.history).toBe(60);
    expect(result.total).toBe(110);
  });

  it('ignores tool-call metadata (only `content` feeds back to the model)', () => {
    const turns: Turn[] = [
      {
        role: 'assistant',
        timestamp: 't1',
        content: 'short reply', // 11 chars → 3 tokens
        toolCalls: [
          {
            name: 'write_memory',
            input: { body: 'x'.repeat(4000) },
            result: { ok: true, summary: 'wrote memory/notes/x.md' },
          },
        ],
      },
    ];
    const result = estimateThreadTokens(turns, '');
    // Only the 11-char content counts; the tool-call payload does not get
    // replayed to the model on subsequent turns, so it shouldn't inflate the
    // budget surface either.
    expect(result.history).toBe(3);
  });
});
