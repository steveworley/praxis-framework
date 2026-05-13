/**
 * Render a unified-diff string as colored per-line HTML spans. Line classes
 * are picked from the leading character of each line:
 *
 *   ' '   context     → no class
 *   '+'   addition    → .added (but skip `+++` file marker)
 *   '-'   removal     → .removed (but skip `---` file marker)
 *   '@@'  hunk header → .hunk
 *   else  meta/index  → .meta
 *
 * Returns an HTML string suitable for `x-html` / `set:html`. Callers are
 * responsible for styling the `.diff-line` classes — the rendered markup is
 * neutral and structural.
 *
 * Empty input returns an empty string (so `x-html=""` collapses cleanly).
 */
export function renderUnifiedDiff(diffText: string): string {
  if (!diffText) return '';
  const lines = diffText.split('\n');
  const parts: string[] = [];
  for (const raw of lines) {
    let cls = 'diff-line';
    if (raw.startsWith('@@')) cls += ' hunk';
    else if (
      raw.startsWith('+++') ||
      raw.startsWith('---') ||
      raw.startsWith('Index:') ||
      raw.startsWith('===')
    ) {
      cls += ' meta';
    } else if (raw.startsWith('+')) cls += ' added';
    else if (raw.startsWith('-')) cls += ' removed';
    parts.push(`<span class="${cls}">${escapeHtml(raw || ' ')}</span>`);
  }
  return parts.join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
