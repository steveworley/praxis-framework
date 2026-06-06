// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { collectVisuals } from './visuals.ts';

describe('collectVisuals', () => {
  it('finds visual figures inside a [data-praxis-visuals] root', () => {
    document.body.innerHTML = `
      <div data-praxis-visuals>
        <figure class="praxis-visual" data-kind="mermaid">
          <pre class="praxis-visual-source">flowchart LR
A--&gt;B</pre>
        </figure>
        <figure class="praxis-visual" data-kind="vega-lite">
          <pre class="praxis-visual-source">{"mark":"bar"}</pre>
        </figure>
      </div>`;
    const found = collectVisuals(document);
    expect(found).toHaveLength(2);
    expect(found[0]?.kind).toBe('mermaid');
    expect(found[0]?.source).toContain('flowchart LR');
    expect(found[1]?.kind).toBe('vega-lite');
  });

  it('ignores visual figures NOT inside a [data-praxis-visuals] root (e.g. chat transcript)', () => {
    document.body.innerHTML = `
      <div class="chat-transcript">
        <figure class="praxis-visual" data-kind="mermaid">
          <pre class="praxis-visual-source">flowchart LR</pre>
        </figure>
      </div>`;
    expect(collectVisuals(document)).toHaveLength(0);
  });

  it('skips already-rendered figures and returns only fresh ones', () => {
    document.body.innerHTML = `
      <div data-praxis-visuals>
        <figure class="praxis-visual" data-kind="mermaid" data-rendered="true">
          <pre class="praxis-visual-source">flowchart LR</pre>
        </figure>
        <figure class="praxis-visual" data-kind="vega-lite">
          <pre class="praxis-visual-source">{"mark":"bar"}</pre>
        </figure>
      </div>`;
    const found = collectVisuals(document);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('vega-lite');
  });

  it('skips figures already marked as errored so failed renders are not retried', () => {
    document.body.innerHTML = `
      <div data-praxis-visuals>
        <figure class="praxis-visual" data-kind="mermaid" data-rendered="error">
          <pre class="praxis-visual-source">flowchart LR</pre>
        </figure>
        <figure class="praxis-visual" data-kind="vega-lite">
          <pre class="praxis-visual-source">{"mark":"bar"}</pre>
        </figure>
      </div>`;
    const found = collectVisuals(document);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('vega-lite');
  });
});
