import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders headings', () => {
    const out = renderMarkdown('# Title');
    expect(out).toContain('<h1>Title</h1>');
  });

  it('renders inline bold and inline code', () => {
    const out = renderMarkdown('hello **world** and `code`');
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('<code>code</code>');
  });

  it('renders blockquotes (including nested)', () => {
    const out = renderMarkdown('> outer\n> > inner');
    expect(out).toContain('<blockquote>');
    // nested blockquote — markdown-it nests them as separate elements
    const blockquoteCount = (out.match(/<blockquote>/g) ?? []).length;
    expect(blockquoteCount).toBeGreaterThanOrEqual(2);
  });

  it('renders GFM tables', () => {
    const md = ['| col1 | col2 |', '| --- | --- |', '| a | b |'].join('\n');
    const out = renderMarkdown(md);
    expect(out).toContain('<table>');
    expect(out).toContain('<thead>');
    expect(out).toContain('<tbody>');
    expect(out).toContain('<th>col1</th>');
    expect(out).toContain('<td>a</td>');
  });

  it('renders ordered and nested lists', () => {
    const md = '1. one\n2. two\n   - nested\n   - also nested\n3. three';
    const out = renderMarkdown(md);
    expect(out).toContain('<ol>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one');
    expect(out).toContain('<li>nested</li>');
  });

  it('renders fenced code blocks preserving newlines', () => {
    const md = '```\nline one\nline two\n```';
    const out = renderMarkdown(md);
    expect(out).toContain('<pre>');
    expect(out).toContain('<code>');
    expect(out).toContain('line one\nline two');
  });

  it('renders a horizontal rule for ---', () => {
    expect(renderMarkdown('---')).toContain('<hr>');
  });

  it('linkifies bare URLs', () => {
    const out = renderMarkdown('see https://example.com for details');
    expect(out).toContain('href="https://example.com"');
  });

  it('escapes raw HTML rather than emitting it (XSS protection)', () => {
    const out = renderMarkdown('hello <script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders a mermaid fence as a visual figure with escaped source preserved', () => {
    const out = renderMarkdown('```mermaid\nflowchart LR\n  A-->B\n```');
    expect(out).toContain('class="praxis-visual"');
    expect(out).toContain('data-kind="mermaid"');
    expect(out).toContain('class="praxis-visual-source"');
    expect(out).toContain('flowchart LR');
  });

  it('renders a vega-lite fence as a visual figure', () => {
    const out = renderMarkdown('```vega-lite\n{"mark":"bar"}\n```');
    expect(out).toContain('class="praxis-visual"');
    expect(out).toContain('data-kind="vega-lite"');
    expect(out).toContain('{&quot;mark&quot;:&quot;bar&quot;}');
  });

  it('escapes HTML inside a visual fence (no raw script leaks)', () => {
    const out = renderMarkdown('```mermaid\n<script>alert(1)</script>\n```');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('leaves unknown fence languages as plain code blocks', () => {
    const out = renderMarkdown('```python\nprint(1)\n```');
    expect(out).not.toContain('praxis-visual');
    expect(out).toContain('<pre>');
    expect(out).toContain('<code');
  });
});

describe('escapeHtml', () => {
  it('escapes the four entities it cares about', () => {
    expect(escapeHtml('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  });
});
