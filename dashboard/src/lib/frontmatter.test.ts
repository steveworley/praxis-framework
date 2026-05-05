import { describe, expect, it } from 'vitest';

import { extractTitle, parseFrontmatter } from './frontmatter.ts';

describe('parseFrontmatter', () => {
  it('parses a frontmatter block', () => {
    const text = `---\ncreated: 2026-05-01\nupdated: "2026-05-05"\n---\n\n# Hello\n\nbody`;
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter['created']).toBe('2026-05-01');
    expect(frontmatter['updated']).toBe('2026-05-05');
    expect(body.trimStart().startsWith('# Hello')).toBe(true);
  });

  it('returns the whole text as body when no frontmatter is present', () => {
    const text = `# Hello\n\nbody`;
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('strips single and double quotes from values', () => {
    const text = `---\nfoo: 'bar'\nbaz: "qux"\n---\nbody`;
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter['foo']).toBe('bar');
    expect(frontmatter['baz']).toBe('qux');
  });
});

describe('extractTitle', () => {
  it('returns the first H1', () => {
    expect(extractTitle('\n# My Title\n\nbody', 'fallback')).toBe('My Title');
  });

  it('falls back to the prettified stem when no H1 is found', () => {
    expect(extractTitle('plain body', 'some-thing_here')).toBe('Some Thing Here');
  });

  it('does not pick up a heading that follows non-empty content', () => {
    expect(extractTitle('lead in\n# Title later', 'fallback')).toBe('Fallback');
  });
});
