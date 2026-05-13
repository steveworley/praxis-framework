import { describe, expect, it } from 'vitest';

import { renderUnifiedDiff } from './diff.ts';

describe('renderUnifiedDiff', () => {
  it('returns empty string for empty input', () => {
    expect(renderUnifiedDiff('')).toBe('');
  });

  it('classifies addition / removal / hunk / meta lines', () => {
    const diff = [
      'Index: persona.md',
      '--- persona.md',
      '+++ persona.md',
      '@@ -1,2 +1,2 @@',
      ' context line',
      '-removed line',
      '+added line',
    ].join('\n');
    const html = renderUnifiedDiff(diff);
    expect(html).toContain('class="diff-line meta">Index:');
    expect(html).toContain('class="diff-line meta">---');
    expect(html).toContain('class="diff-line meta">+++');
    expect(html).toContain('class="diff-line hunk">@@');
    expect(html).toContain('class="diff-line removed">-removed');
    expect(html).toContain('class="diff-line added">+added');
  });

  it('escapes HTML in diff content', () => {
    const diff = '+<script>alert("x")</script>';
    const html = renderUnifiedDiff(diff);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
