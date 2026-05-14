import fs from 'node:fs/promises';
import path from 'node:path';

import { extractTitle, parseFrontmatter } from './frontmatter.ts';

/**
 * The escalation `kind` taxonomy. Adding a new kind means updating four
 * places in lockstep: this union, `CreateEscalationInput` in
 * `chat/tools.ts`, the tool schema enum in `chat/tool-schemas.ts`, and the
 * filter chip + lab style on the dashboard surfaces.
 */
export type EscalationKind = 'help' | 'improvement' | 'proposed_skill' | 'criterion_drift';

export const ESCALATION_KINDS: readonly EscalationKind[] = [
  'help',
  'improvement',
  'proposed_skill',
  'criterion_drift',
];

const ESCALATION_FIELDS = new Set([
  'kind',
  'urgency',
  'created',
  'status',
  'agent_context',
  'proposed_skill',
  // criterion_drift-specific fields. Always parsed (the loader is shape-
  // agnostic); only meaningful when `kind === 'criterion_drift'`.
  'criterion',
  'trend',
  'runs',
]);

const STATUS_RANK: Record<string, number> = {
  open: 0,
  resolved: 1,
  accepted: 1,
  declined: 2,
};

const URGENCY_RANK: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export interface EscalationEntry {
  slug: string;
  path: string;
  title: string;
  kind: string;
  urgency: string;
  status: string;
  created: string | null;
  agent_context: string | null;
  proposed_skill_path: string | null;
  proposed_skill_body: string | null;
  /**
   * `criterion_drift`-specific frontmatter. Always present on the entry
   * object (null when the escalation isn't of that kind or the field was
   * omitted) so callers don't have to widen the type per kind.
   */
  criterion: string | null;
  trend: string | null;
  runs: number | null;
  body: string;
}

export interface EscalationsResult {
  entries: EscalationEntry[];
  countsByStatus: Record<'open' | 'resolved' | 'accepted' | 'declined', number>;
}

/**
 * Walk escalations/*.md (non-recursive), parse the whitelisted frontmatter,
 * inline drafts referenced as kind: proposed_skill, and sort by status →
 * urgency → date desc. Mirrors the Python `_assemble_escalations`.
 */
export async function assembleEscalations(roleHome: string): Promise<EscalationsResult> {
  const escDir = path.join(roleHome, 'escalations');
  const counts = { open: 0, resolved: 0, accepted: 0, declined: 0 };
  if (!(await pathExists(escDir))) {
    return { entries: [], countsByStatus: counts };
  }

  let dirEntries;
  try {
    dirEntries = await fs.readdir(escDir, { withFileTypes: true });
  } catch {
    return { entries: [], countsByStatus: counts };
  }

  const mdFiles = dirEntries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .filter((e) => e.name.toLowerCase() !== 'readme.md')
    .map((e) => path.join(escDir, e.name))
    .sort();

  const entries: EscalationEntry[] = [];
  for (const filePath of mdFiles) {
    const entry = await parseEscalation(filePath, roleHome);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 9;
    const sb = STATUS_RANK[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const ua = URGENCY_RANK[a.urgency] ?? 9;
    const ub = URGENCY_RANK[b.urgency] ?? 9;
    if (ua !== ub) return ua - ub;
    return dateKey(b.created) - dateKey(a.created);
  });

  for (const e of entries) {
    if (e.status === 'open' || e.status === 'resolved' || e.status === 'accepted' || e.status === 'declined') {
      counts[e.status] += 1;
    }
  }

  return { entries, countsByStatus: counts };
}

async function parseEscalation(filePath: string, roleHome: string): Promise<EscalationEntry | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(text);
  const fm: Record<string, string> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (ESCALATION_FIELDS.has(k) && v.length > 0) fm[k] = v;
  }

  const stem = path.basename(filePath, path.extname(filePath));
  const title = extractTitle(body, stem);

  let proposedBody: string | null = null;
  const proposedPath = fm['proposed_skill'];
  if (fm['kind'] === 'proposed_skill' && proposedPath) {
    const proposedRoot = path.resolve(path.join(roleHome, 'verbs', 'proposed'));
    const target = path.resolve(path.join(roleHome, proposedPath));
    const rel = path.relative(proposedRoot, target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) {
          proposedBody = await fs.readFile(target, 'utf-8');
        }
      } catch {
        proposedBody = null;
      }
    }
  }

  const runsRaw = fm['runs'];
  const runsParsed = runsRaw ? Number.parseInt(runsRaw, 10) : Number.NaN;
  const runs = Number.isFinite(runsParsed) ? runsParsed : null;

  return {
    slug: stem,
    path: path.relative(roleHome, filePath),
    title,
    kind: fm['kind'] ?? 'help',
    urgency: fm['urgency'] ?? 'normal',
    status: fm['status'] ?? 'open',
    created: fm['created'] ?? null,
    agent_context: fm['agent_context'] ?? null,
    proposed_skill_path: proposedPath ?? null,
    proposed_skill_body: proposedBody,
    criterion: fm['criterion'] ?? null,
    trend: fm['trend'] ?? null,
    runs,
    body: body.trim(),
  };
}

function dateKey(s: string | null): number {
  if (!s) return 0;
  const digits = s.replace(/-/g, '');
  return /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : 0;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
