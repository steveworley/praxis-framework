import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

export interface AgentSummary {
  /** Path relative to agents/ — e.g. `discover.md` or `proposed/intake-from-tender.md`. */
  file: string;
  /** Human-readable verb derived from the file's first heading or the filename. */
  verb: string;
  /** One-word capability tag inferred from the body — see {@link classifyAgent}. */
  tag: string;
}

export interface AgentsResult {
  live: AgentSummary[];
  proposed: AgentSummary[];
}

const PERSONA_FILE = 'persona.md';

/**
 * List the role's agents. `agents/*.md` (excluding `persona.md`) become live
 * agents; anything under `agents/proposed/` becomes a proposed agent. Both
 * lists are sorted by file path. Files that fail to read are skipped silently.
 */
export async function loadAgents(roleHome: string): Promise<AgentsResult> {
  const agentsDir = path.join(roleHome, 'agents');
  const live: AgentSummary[] = [];
  const proposed: AgentSummary[] = [];

  let topEntries;
  try {
    topEntries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return { live, proposed };
  }

  for (const entry of topEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== PERSONA_FILE) {
      const summary = await summariseAgent(path.join(agentsDir, entry.name), entry.name);
      if (summary) live.push(summary);
    }
  }

  const proposedDir = path.join(agentsDir, 'proposed');
  let proposedEntries: Dirent[] = [];
  try {
    proposedEntries = await fs.readdir(proposedDir, { withFileTypes: true });
  } catch {
    proposedEntries = [];
  }
  for (const entry of proposedEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      const rel = path.join('proposed', entry.name);
      const summary = await summariseAgent(path.join(proposedDir, entry.name), rel);
      if (summary) proposed.push(summary);
    }
  }

  live.sort((a, b) => a.file.localeCompare(b.file));
  proposed.sort((a, b) => a.file.localeCompare(b.file));
  return { live, proposed };
}

/**
 * Count live agents (excluding persona and proposed). Cheaper than loading
 * all summaries when the caller only needs a number.
 */
export async function countLiveAgents(roleHome: string): Promise<number> {
  const agentsDir = path.join(roleHome, 'agents');
  let entries;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== PERSONA_FILE) {
      n += 1;
    }
  }
  return n;
}

async function summariseAgent(absPath: string, relFile: string): Promise<AgentSummary | null> {
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
  const verb = deriveVerb(text, relFile);
  const tag = classifyAgent(text);
  return { file: relFile, verb, tag };
}

function deriveVerb(text: string, relFile: string): string {
  // First H1 wins — strip markdown noise so the rendered verb reads cleanly.
  const headingMatch = /^#\s+(.+)$/m.exec(text);
  if (headingMatch && headingMatch[1]) {
    return headingMatch[1].trim().replace(/\s+agent$/i, '').toLowerCase();
  }
  // Fallback: filename without extension or proposed/ prefix.
  return path.basename(relFile, '.md').replace(/-/g, ' ');
}

/**
 * Pick a one-word capability tag for an agent based on keywords in its body.
 * Heuristic — not a classifier. Order matters: earlier matches win, so put
 * the more specific verbs first. A flat default of "act" catches anything
 * we can't categorise.
 */
export function classifyAgent(text: string): string {
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
