/**
 * Client island that upgrades server-rendered `.praxis-visual` placeholders
 * into inline SVG. Mounted ONLY on work-product surfaces (inside a
 * `[data-praxis-visuals]` root) — never the chat transcript, so chat stays
 * text + reference links.
 *
 * Libraries are dynamically imported per-kind, so a page with no charts never
 * downloads vega, and a page with no diagrams never downloads mermaid.
 *
 * Trust: a visual is never hidden. Before/without hydration it shows a visible
 * placeholder (kind + source); on render failure it keeps the placeholder and
 * shows the error. Nothing is silently dropped.
 */
import { parseSafeVegaSpec } from '@/lib/visuals/vega-safety.ts';

export interface VisualNode {
  kind: string;
  source: string;
  figure: HTMLElement;
}

/** Collect `.praxis-visual` figures that live inside a `[data-praxis-visuals]` root. */
export function collectVisuals(root: ParentNode): VisualNode[] {
  const out: VisualNode[] = [];
  for (const figure of Array.from(
    root.querySelectorAll<HTMLElement>('[data-praxis-visuals] figure.praxis-visual'),
  )) {
    const rendered = figure.dataset['rendered'];
    if (rendered === 'true' || rendered === 'error') continue;
    const kind = figure.dataset['kind'] ?? '';
    const source = figure.querySelector('.praxis-visual-source')?.textContent ?? '';
    out.push({ kind, source, figure });
  }
  return out;
}

function showError(figure: HTMLElement, message: string): void {
  const caption = figure.querySelector('.praxis-visual-fallback');
  if (caption) caption.textContent = message;
  figure.dataset['rendered'] = 'error';
}

function hideSourceAndCaption(figure: HTMLElement): void {
  const source = figure.querySelector('.praxis-visual-source');
  if (source) source.setAttribute('hidden', '');
  const caption = figure.querySelector('.praxis-visual-fallback');
  if (caption) caption.setAttribute('hidden', '');
}

let mermaidIdSeq = 0;

async function renderMermaid(nodes: VisualNode[]): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  for (const node of nodes) {
    try {
      const { svg } = await mermaid.render(`praxis-mermaid-${mermaidIdSeq++}`, node.source);
      const holder = document.createElement('div');
      holder.className = 'praxis-visual-rendered';
      // Safe: mermaid securityLevel:'strict' output is DOMPurify-sanitized (no scripts/handlers).
      holder.innerHTML = svg;
      node.figure.appendChild(holder);
      hideSourceAndCaption(node.figure);
      node.figure.dataset['rendered'] = 'true';
    } catch (e) {
      showError(
        node.figure,
        `Diagram could not be rendered: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function renderVega(nodes: VisualNode[]): Promise<void> {
  const { default: vegaEmbed } = await import('vega-embed');
  for (const node of nodes) {
    const parsed = parseSafeVegaSpec(node.source);
    if (!parsed.ok) {
      showError(node.figure, parsed.error);
      continue;
    }
    try {
      const holder = document.createElement('div');
      holder.className = 'praxis-visual-rendered';
      node.figure.appendChild(holder);
      // `parsed.spec` is a validated `Record<string, unknown>` (JSON object, no
      // remote data) — vega-embed's param type expects a `VisualizationSpec`,
      // so cast locally rather than loosening the safety module's return type.
      await vegaEmbed(holder, parsed.spec as Parameters<typeof vegaEmbed>[1], {
        actions: false,
        renderer: 'svg',
      });
      hideSourceAndCaption(node.figure);
      node.figure.dataset['rendered'] = 'true';
    } catch (e) {
      showError(
        node.figure,
        `Chart could not be rendered: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Entry point — call once on load for a work-product surface. */
export async function initVisuals(root: ParentNode = document): Promise<void> {
  const nodes = collectVisuals(root);
  if (nodes.length === 0) return;
  const mermaidNodes = nodes.filter((n) => n.kind === 'mermaid');
  const vegaNodes = nodes.filter((n) => n.kind === 'vega-lite');
  await Promise.all([
    mermaidNodes.length ? renderMermaid(mermaidNodes) : Promise.resolve(),
    vegaNodes.length ? renderVega(vegaNodes) : Promise.resolve(),
  ]);
}
