import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export interface VerbSummary {
  /** Path relative to verbs/ — e.g. `discover.md` or `proposed/intake-from-tender.md`. */
  file: string;
  /** Human-readable label derived from the file's first heading or the filename. */
  label: string;
  /** One-word capability tag inferred from the body — see {@link classifyVerb}. */
  tag: string;
}

export interface VerbsResult {
  live: VerbSummary[];
  proposed: VerbSummary[];
}

/**
 * Parsed frontmatter for a live verb. The seed writes `verb`/`when_to_run`/
 * `inputs`/`outputs` placeholders; accepted-proposal verbs additionally carry
 * `description`/`proposed_by`/`created`/`accepted_at`/`status`. Every field is
 * optional — operators may strip placeholders they haven't filled in.
 */
export interface VerbFrontmatter {
  /** verb-tag (intake/research/produce/etc.) — may be `<unset>`. */
  verb?: string;
  when_to_run?: string;
  /** Inline `[]` or block-style list; empty array when missing. */
  inputs?: string[];
  outputs?: string[];
  description?: string;
  proposed_by?: string;
  created?: string;
  accepted_at?: string;
  status?: string;
}

export interface VerbDetail {
  /** URL slug (filename stem, e.g. `escalate`). */
  slug: string;
  /** Path relative to the role home (always `verbs/<slug>.md`). */
  file: string;
  /** Human-readable label — same resolution as {@link summariseVerb}'s label. */
  label: string;
  /** One-word capability tag — same as {@link classifyVerb}. */
  tag: string;
  frontmatter: VerbFrontmatter;
  /** Raw markdown body (frontmatter stripped). */
  body: string;
}

const VERB_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * List the role's verbs. `verbs/*.md` becomes live verbs; anything under
 * `verbs/proposed/` becomes a proposed verb. Both lists are sorted by file
 * path. Files that fail to read are skipped silently.
 */
export async function loadVerbs(roleHome: string): Promise<VerbsResult> {
  const verbsDir = path.join(roleHome, 'verbs');
  const live: VerbSummary[] = [];
  const proposed: VerbSummary[] = [];

  let topEntries;
  try {
    topEntries = await fs.readdir(verbsDir, { withFileTypes: true });
  } catch {
    return { live, proposed };
  }

  for (const entry of topEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const summary = await summariseVerb(path.join(verbsDir, entry.name), entry.name);
      if (summary) live.push(summary);
    }
  }

  const proposedDir = path.join(verbsDir, 'proposed');
  let proposedEntries: Dirent[] = [];
  try {
    proposedEntries = await fs.readdir(proposedDir, { withFileTypes: true });
  } catch {
    proposedEntries = [];
  }
  for (const entry of proposedEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      const rel = path.join('proposed', entry.name);
      const summary = await summariseVerb(path.join(proposedDir, entry.name), rel);
      if (summary) proposed.push(summary);
    }
  }

  live.sort((a, b) => a.file.localeCompare(b.file));
  proposed.sort((a, b) => a.file.localeCompare(b.file));
  return { live, proposed };
}

/**
 * Count live verbs (excluding proposed). Cheaper than loading all summaries
 * when the caller only needs a number.
 */
export async function countLiveVerbs(roleHome: string): Promise<number> {
  const verbsDir = path.join(roleHome, 'verbs');
  let entries;
  try {
    entries = await fs.readdir(verbsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      n += 1;
    }
  }
  return n;
}

async function summariseVerb(absPath: string, relFile: string): Promise<VerbSummary | null> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
  const label = deriveLabel(text, relFile);
  const tag = classifyVerb(text);
  return { file: relFile, label, tag };
}

function deriveLabel(text: string, relFile: string): string {
  const slug = path.basename(relFile, '.md');
  // Prefer frontmatter `description` when present — role-proposed verbs carry
  // a human-readable description there; their H1 is just the slug echoed back.
  const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (fmMatch && fmMatch[1]) {
    const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
    if (descMatch && descMatch[1]) {
      const desc = descMatch[1].trim().replace(/^["']|["']$/g, '');
      if (desc.length > 0) return desc;
    }
  }
  // Next: first H1, unless it just repeats the slug (operator-meaningful H1 wins).
  const headingMatch = /^#\s+(.+)$/m.exec(text);
  if (headingMatch && headingMatch[1]) {
    const heading = headingMatch[1].trim().replace(/\s+verb$/i, '').toLowerCase();
    if (heading !== slug.toLowerCase()) return heading;
  }
  // Fallback: filename without extension, slug-with-spaces.
  return slug.replace(/-/g, ' ');
}

/**
 * Pick a one-word capability tag for a verb based on keywords in its body.
 * Heuristic — not a classifier. Order matters: earlier matches win, so put
 * the more specific verbs first. A flat default of "act" catches anything
 * we can't categorise.
 */
export function classifyVerb(text: string): string {
  const haystack = text.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\bescalat|reflect\b/, 'reflect'],
    [/\brespond|reply\b/, 'respond'],
    [/\bmonitor|watch\b/, 'monitor'],
    [/\breview\b/, 'review'],
    [/\bdraft|write|compose\b/, 'produce'],
    [/\bresearch|read\b/, 'research'],
    [/\bfind|intake|discover\b/, 'intake'],
    [/\bsend|act\b/, 'act'],
  ];
  for (const [pattern, tag] of rules) {
    if (pattern.test(haystack)) return tag;
  }
  return 'act';
}

/**
 * Load a single live verb by slug. Returns null when the file doesn't exist
 * so the caller (page or API route) can render a 404. Refuses any slug that
 * doesn't match the canonical kebab-case shape — same rule the triage layer
 * uses for proposed drafts, kept in sync deliberately.
 */
export async function loadVerb(roleHome: string, slug: string): Promise<VerbDetail | null> {
  if (!VERB_SLUG_RE.test(slug)) {
    throw new Error(`Invalid verb slug: '${slug}'. Must match ${VERB_SLUG_RE}.`);
  }
  const rel = path.join('verbs', `${slug}.md`);
  const absPath = path.join(roleHome, rel);

  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseVerbFrontmatter(text);
  const label = deriveLabel(text, `${slug}.md`);
  const tag = classifyVerb(text);

  return {
    slug,
    file: rel,
    label,
    tag,
    frontmatter,
    body,
  };
}

/**
 * Verb-specific frontmatter parser. Unlike the shared {@link parseFrontmatter}
 * (line-based `key: value` only), verbs carry list-shaped `inputs`/`outputs`
 * fields written either as inline `[]` (seed default) or as YAML block lists:
 *
 *   inputs:
 *     - lib/customers.yaml
 *     - memory/notes/
 *
 * We handle both. Strings are unquoted, empty arrays stay empty, and the body
 * after the closing `---` is returned verbatim (no leading-newline trimming so
 * markdown renderers see the original structure).
 */
function parseVerbFrontmatter(text: string): { frontmatter: VerbFrontmatter; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const block = match[1] ?? '';
  const body = match[2] ?? '';

  const fm: VerbFrontmatter = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim().length === 0) continue;
    // Block-list children (`  - foo`) are consumed by the parent key below.
    if (/^\s+-\s+/.test(raw)) continue;
    const colonIdx = raw.indexOf(':');
    if (colonIdx < 0) continue;
    const key = raw.slice(0, colonIdx).trim().toLowerCase();
    const rest = raw.slice(colonIdx + 1).trim();

    if (key === 'inputs' || key === 'outputs') {
      const values: string[] = [];
      if (rest.length > 0) {
        // Inline form: `inputs: []` or `inputs: [a, b]`.
        const inline = /^\[(.*)\]$/.exec(rest);
        if (inline) {
          const inner = inline[1]?.trim() ?? '';
          if (inner.length > 0) {
            for (const part of inner.split(',')) {
              const v = stripQuotes(part.trim());
              if (v.length > 0) values.push(v);
            }
          }
        } else {
          // Single scalar after the colon — treat as a one-element list.
          const v = stripQuotes(rest);
          if (v.length > 0) values.push(v);
        }
      } else {
        // Block-list children on subsequent indented `- foo` lines.
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j] ?? '';
          const listMatch = /^\s+-\s+(.+)$/.exec(next);
          if (!listMatch) break;
          values.push(stripQuotes(listMatch[1]!.trim()));
          j += 1;
        }
      }
      fm[key] = values;
      continue;
    }

    const scalar = stripQuotes(rest);
    if (
      key === 'verb' ||
      key === 'when_to_run' ||
      key === 'description' ||
      key === 'proposed_by' ||
      key === 'created' ||
      key === 'accepted_at' ||
      key === 'status'
    ) {
      fm[key] = scalar;
    }
  }
  return { frontmatter: fm, body };
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
 * List `.yaml`/`.yml` files directly under `lib/`. Used by /role's reference-data
 * group. Returns paths relative to the role home (e.g. `lib/customers.yaml`).
 */
export async function listLibFiles(roleHome: string): Promise<string[]> {
  const libDir = path.join(roleHome, 'lib');
  let entries;
  try {
    entries = await fs.readdir(libDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => `lib/${e.name}`)
    .sort();
}
