import type { PersistedToolCall } from './conversation.ts';

/** A reference chip the chat transcript renders for a work-product the role wrote. */
export interface WorkProductRef {
  type: string;
  slug: string;
  href: string;
  label: string;
}

/** Map a repo output path (`output/<rest>.md`) to its dashboard route (`/output/<rest>`). */
export function outputPathToHref(relPath: string): string {
  const rest = relPath.replace(/^output\//, '').replace(/\.md$/, '');
  return `/output/${rest}`;
}

/**
 * From a turn's tool calls, surface every work-product the role successfully
 * wrote (`write_output` with `result.ok`). Used to render chat reference chips
 * — chat links to the work-product, it does not render it inline.
 */
export function deriveWorkProducts(toolCalls?: PersistedToolCall[]): WorkProductRef[] {
  if (!toolCalls) return [];
  const refs: WorkProductRef[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== 'write_output' || !tc.result.ok) continue;
    const data = tc.result.data ?? {};
    const path = typeof data['path'] === 'string' ? (data['path'] as string) : null;
    if (!path) continue;
    const type = typeof data['type'] === 'string' ? (data['type'] as string) : (path.split('/')[1] ?? 'output');
    const slug = typeof data['slug'] === 'string' ? (data['slug'] as string) : '';
    refs.push({
      type,
      slug,
      href: outputPathToHref(path),
      label: slug ? `${type} · ${slug}` : type,
    });
  }
  return refs;
}
