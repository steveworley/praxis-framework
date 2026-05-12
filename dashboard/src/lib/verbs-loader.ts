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
