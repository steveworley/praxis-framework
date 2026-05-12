import { describe, expect, it } from 'vitest';

import { firstLine } from './text.js';

describe('firstLine', () => {
  it('returns the first line of a multi-line string', () => {
    expect(firstLine('hello\nworld\nthere')).toBe('hello');
  });

  it('returns the whole string when there is no newline', () => {
    expect(firstLine('one-liner')).toBe('one-liner');
  });

  it('returns an empty string for an empty input', () => {
    expect(firstLine('')).toBe('');
  });

  it('returns the empty string when the input starts with a newline', () => {
    expect(firstLine('\nleading newline')).toBe('');
  });
});
