/**
 * Tiny string utilities used by dashboard surfaces that render server-side
 * derived metadata (commit messages, headlines, body previews).
 */

/** Return the first line of a multi-line string. Useful for collapsing git
 * commit messages or block-quoted notes into a single feed-row headline. */
export function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx >= 0 ? text.slice(0, idx) : text;
}
