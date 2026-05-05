/**
 * Minimal YAML-frontmatter parser. Mirrors the Python implementation: only
 * `key: value` lines, optional surrounding `---` block at the start of the
 * file, single/double quote stripping. We don't need full YAML.
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export interface FrontmatterParseResult {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): FrontmatterParseResult {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text };
  }
  const block = match[1] ?? '';
  const body = match[2] ?? '';
  const frontmatter: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx < 0) continue;
    const key = rawLine.slice(0, colonIdx).trim().toLowerCase();
    const value = stripQuotes(rawLine.slice(colonIdx + 1).trim());
    if (key.length === 0) continue;
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * First-H1 title extraction with a filename fallback. Skips frontmatter and
 * blank lines until it finds either an H1 or non-empty content.
 */
export function extractTitle(body: string, fallbackStem: string): string {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('# ')) {
      return line.slice(2).trim();
    }
    if (line.length > 0) {
      // Hit a non-heading line first — keep the filename fallback.
      break;
    }
  }
  return prettifyStem(fallbackStem);
}

function prettifyStem(stem: string): string {
  return stem
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
