import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { commitChange, type CommitResult } from './audit.ts';
import { extractTitle, parseFrontmatter } from './frontmatter.ts';

/**
 * Operator-side triage primitives. Reads + mutates the two surfaces the role
 * uses to "raise its hand": escalations (one md per file under
 * `escalations/`) and proposed verbs (drafts under `verbs/proposed/`).
 *
 * Every mutation is atomic (write to a tmp file in the same dir, then
 * rename) so a crash mid-write can't leave a half-rendered frontmatter on
 * disk. Every id/slug is validated against a narrow regex AND
 * normalisation is enforced via `resolveInsideRoleHome`-style checks so a
 * traversal-y input (`../../etc/passwd`, `escalations/../foo`) can't escape
 * its sub-directory.
 *
 * Git commits per action are out of scope for this dispatch (#2 ships
 * commit-per-action). The disk shape is fully ready for that follow-up — a
 * commit hook would just wrap the same write paths.
 */

// ---- Shared types -------------------------------------------------------

export interface EscalationSummary {
  /** Filename stem (no `.md`). Used as the URL id. */
  id: string;
  /** Path relative to the role home. */
  path: string;
  title: string;
  kind: 'help' | 'improvement' | 'proposed_skill' | string;
  urgency: 'low' | 'normal' | 'high' | string;
  status: 'open' | 'accepted' | 'declined' | 'resolved' | string;
  created: string | null;
  agent_context: string | null;
  proposed_skill_path: string | null;
}

export interface EscalationDetail extends EscalationSummary {
  body: string;
  frontmatter: Record<string, string>;
  /**
   * Audit-commit metadata. Set only by mutation calls (accept/decline/
   * comment); read helpers leave both undefined. `commit_sha` is present
   * when the audit commit landed; `commit_warning` describes why it didn't
   * when something went wrong (no repo, no diff, etc.).
   */
  commit_sha?: string;
  commit_warning?: string;
}

export interface ProposedVerbSummary {
  slug: string;
  path: string;
  description: string | null;
  status: string;
  created: string | null;
  proposed_by: string | null;
}

export interface ProposedVerbDetail extends ProposedVerbSummary {
  body: string;
  frontmatter: Record<string, string>;
  /**
   * Audit-commit metadata. See EscalationDetail — same shape, same rules.
   */
  commit_sha?: string;
  commit_warning?: string;
}

export type EscalationStatusFilter = 'open' | 'accepted' | 'declined' | 'resolved' | 'all';

// ---- Typed errors ------------------------------------------------------

export class TriageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageNotFoundError';
  }
}

export class TriageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriageValidationError';
  }
}

// ---- Path safety -------------------------------------------------------

const ESCALATION_ID_RE = /^[A-Za-z0-9._-]+$/;
const VERB_SLUG_RE = /^[a-z][a-z0-9-]*$/;

function assertSafeEscalationId(id: string): void {
  if (id.length === 0 || id.length > 200 || !ESCALATION_ID_RE.test(id)) {
    throw new TriageValidationError(
      `Invalid escalation id: '${id}'. Must match ${ESCALATION_ID_RE} and be 1..200 chars.`,
    );
  }
}

function assertSafeVerbSlug(slug: string): void {
  if (slug.length === 0 || slug.length > 80 || !VERB_SLUG_RE.test(slug)) {
    throw new TriageValidationError(
      `Invalid verb slug: '${slug}'. Must match ${VERB_SLUG_RE} and be 1..80 chars.`,
    );
  }
}

function escalationPath(roleHome: string, id: string): string {
  assertSafeEscalationId(id);
  const abs = path.resolve(roleHome, 'escalations', `${id}.md`);
  const escDir = path.resolve(roleHome, 'escalations');
  const rel = path.relative(escDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new TriageValidationError(`Escalation path escapes escalations/: ${id}`);
  }
  return abs;
}

function proposedVerbPath(roleHome: string, slug: string): string {
  assertSafeVerbSlug(slug);
  const abs = path.resolve(roleHome, 'verbs', 'proposed', `${slug}.md`);
  const proposedDir = path.resolve(roleHome, 'verbs', 'proposed');
  const rel = path.relative(proposedDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new TriageValidationError(`Verb path escapes verbs/proposed/: ${slug}`);
  }
  return abs;
}

function liveVerbPath(roleHome: string, slug: string): string {
  assertSafeVerbSlug(slug);
  const abs = path.resolve(roleHome, 'verbs', `${slug}.md`);
  const verbsDir = path.resolve(roleHome, 'verbs');
  const rel = path.relative(verbsDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new TriageValidationError(`Live verb path escapes verbs/: ${slug}`);
  }
  return abs;
}

// ---- Audit commit helper -----------------------------------------------

/**
 * Apply a CommitResult's metadata onto a detail object. Mutation callers
 * use this so the API layer can pick up `commit_warning` (and the operator
 * UI can surface it inline).
 */
function attachCommitMeta<T extends { commit_sha?: string; commit_warning?: string }>(
  detail: T,
  commit: CommitResult,
): T {
  if (commit.committed && commit.sha) detail.commit_sha = commit.sha;
  if (commit.warning) detail.commit_warning = commit.warning;
  return detail;
}

// ---- Atomic write ------------------------------------------------------

async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    // Clean up the tmp file on failure so we don't leave litter.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

// ---- Frontmatter serialisation ----------------------------------------
//
// We re-serialise frontmatter when mutating it. The format mirrors
// chat/tools.ts: simple `key: value`, quoting values that contain colons /
// hashes / lead with YAML-significant chars.

function renderFrontmatterMap(fields: Record<string, string>, order: readonly string[]): string {
  const lines = ['---'];
  const seen = new Set<string>();
  for (const key of order) {
    if (key in fields) {
      lines.push(`${key}: ${quoteIfNeeded(fields[key]!)}`);
      seen.add(key);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (seen.has(k)) continue;
    lines.push(`${k}: ${quoteIfNeeded(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  if (/^[\s'"#&*!|>%@`\-?,[\]{}]/.test(value) || /[:#]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

const ESCALATION_FIELD_ORDER = [
  'kind',
  'urgency',
  'created',
  'agent_context',
  'proposed_skill',
  'status',
  'decline_reason',
];

const VERB_FIELD_ORDER = [
  'description',
  'proposed_by',
  'created',
  'status',
  'decline_reason',
];

// ---- Date helpers ------------------------------------------------------

function localDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function localIsoString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offHh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offMm = String(absOffset % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${offHh}:${offMm}`;
}

// ---- Escalations: read --------------------------------------------------

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

async function readEscalationFile(abs: string, roleHome: string): Promise<EscalationDetail | null> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(text);
  const stem = path.basename(abs, path.extname(abs));
  const title = extractTitle(body, stem);

  return {
    id: stem,
    path: path.relative(roleHome, abs),
    title,
    kind: frontmatter['kind'] ?? 'help',
    urgency: frontmatter['urgency'] ?? 'normal',
    status: frontmatter['status'] ?? 'open',
    created: frontmatter['created'] ?? null,
    agent_context: frontmatter['agent_context'] ?? null,
    proposed_skill_path: frontmatter['proposed_skill'] ?? null,
    body,
    frontmatter,
  };
}

function toEscalationSummary(d: EscalationDetail): EscalationSummary {
  return {
    id: d.id,
    path: d.path,
    title: d.title,
    kind: d.kind,
    urgency: d.urgency,
    status: d.status,
    created: d.created,
    agent_context: d.agent_context,
    proposed_skill_path: d.proposed_skill_path,
  };
}

/**
 * List escalations, optionally filtered by status. The result is sorted
 * status → urgency → date desc, the same order as the read-only
 * /escalations page.
 */
export async function listEscalations(
  roleHome: string,
  statusFilter: EscalationStatusFilter = 'all',
): Promise<EscalationSummary[]> {
  const escDir = path.join(roleHome, 'escalations');
  let dirEntries;
  try {
    dirEntries = await fs.readdir(escDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = dirEntries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .filter((e) => e.name.toLowerCase() !== 'readme.md')
    .map((e) => path.join(escDir, e.name));

  const details: EscalationDetail[] = [];
  for (const f of files) {
    const d = await readEscalationFile(f, roleHome);
    if (d) details.push(d);
  }

  const filtered = statusFilter === 'all' ? details : details.filter((d) => d.status === statusFilter);

  filtered.sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 9;
    const sb = STATUS_RANK[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const ua = URGENCY_RANK[a.urgency] ?? 9;
    const ub = URGENCY_RANK[b.urgency] ?? 9;
    if (ua !== ub) return ua - ub;
    return dateKey(b.created) - dateKey(a.created);
  });

  return filtered.map(toEscalationSummary);
}

/**
 * Convenience wrapper for the triage queue — open escalations only.
 */
export async function listOpenEscalations(roleHome: string): Promise<EscalationSummary[]> {
  return listEscalations(roleHome, 'open');
}

export async function loadEscalation(roleHome: string, id: string): Promise<EscalationDetail> {
  const abs = escalationPath(roleHome, id);
  const detail = await readEscalationFile(abs, roleHome);
  if (!detail) {
    throw new TriageNotFoundError(`Escalation not found: ${id}`);
  }
  return detail;
}

// ---- Escalations: mutations --------------------------------------------

async function rewriteEscalation(
  roleHome: string,
  id: string,
  mutateFm: (fm: Record<string, string>) => void,
  bodyAppend?: string,
): Promise<EscalationDetail> {
  const abs = escalationPath(roleHome, id);
  const existing = await readEscalationFile(abs, roleHome);
  if (!existing) {
    throw new TriageNotFoundError(`Escalation not found: ${id}`);
  }

  const fm = { ...existing.frontmatter };
  mutateFm(fm);

  let body = existing.body;
  if (bodyAppend) {
    // Make sure we always finish with one trailing newline before appending
    // a new note block.
    const trimmed = body.replace(/\s+$/, '');
    body = `${trimmed}\n\n${bodyAppend.trim()}\n`;
  }

  const content = `${renderFrontmatterMap(fm, ESCALATION_FIELD_ORDER)}\n${body.startsWith('\n') ? body : `\n${body}`}`;
  await atomicWrite(abs, content);

  const refreshed = await readEscalationFile(abs, roleHome);
  if (!refreshed) {
    throw new Error(`Failed to re-read escalation after write: ${id}`);
  }
  return refreshed;
}

/**
 * Accept an escalation. For `help`/`improvement` kinds we mark `accepted`
 * (operator has acknowledged and acted/will act). For `proposed_skill` use
 * acceptProposedVerb() — that one also moves the draft.
 *
 * The optional operator_note gets appended as an `## Operator note`
 * section.
 */
export async function acceptEscalation(
  roleHome: string,
  id: string,
  operatorNote?: string,
  now: Date = new Date(),
): Promise<EscalationDetail> {
  const detail = await rewriteEscalation(
    roleHome,
    id,
    (fm) => {
      fm['status'] = 'accepted';
      delete fm['decline_reason'];
    },
    operatorNote ? operatorNoteBlock('accepted', operatorNote, now) : `\n## Operator note · ${localIsoString(now)}\n\nAccepted.\n`,
  );
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [detail.path],
    scope: 'triage',
    subject: `accept escalation ${id}`,
    body: operatorNote && operatorNote.trim().length > 0 ? operatorNote.trim() : undefined,
  });
  return attachCommitMeta(detail, commit);
}

export async function declineEscalation(
  roleHome: string,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<EscalationDetail> {
  if (reason.trim().length === 0) {
    throw new TriageValidationError('Decline reason is required.');
  }
  const detail = await rewriteEscalation(
    roleHome,
    id,
    (fm) => {
      fm['status'] = 'declined';
      fm['decline_reason'] = reason.trim();
    },
    operatorNoteBlock('declined', reason, now),
  );
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [detail.path],
    scope: 'triage',
    subject: `decline escalation ${id}`,
    body: reason.trim(),
  });
  return attachCommitMeta(detail, commit);
}

export async function commentOnEscalation(
  roleHome: string,
  id: string,
  note: string,
  now: Date = new Date(),
): Promise<EscalationDetail> {
  if (note.trim().length === 0) {
    throw new TriageValidationError('Comment note is required.');
  }
  const detail = await rewriteEscalation(roleHome, id, () => {}, operatorNoteBlock('comment', note, now));
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [detail.path],
    scope: 'triage',
    subject: `comment on escalation ${id}`,
    body: note.trim(),
  });
  return attachCommitMeta(detail, commit);
}

function operatorNoteBlock(kind: 'accepted' | 'declined' | 'comment', note: string, now: Date): string {
  const heading = `## Operator note · ${localIsoString(now)} · ${kind}`;
  return `${heading}\n\n${note.trim()}\n`;
}

// ---- Proposed verbs: read ----------------------------------------------

async function readProposedVerbFile(abs: string, roleHome: string): Promise<ProposedVerbDetail | null> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(text);
  const stem = path.basename(abs, path.extname(abs));
  return {
    slug: stem,
    path: path.relative(roleHome, abs),
    description: frontmatter['description'] ?? null,
    status: frontmatter['status'] ?? 'proposed',
    created: frontmatter['created'] ?? null,
    proposed_by: frontmatter['proposed_by'] ?? null,
    body,
    frontmatter,
  };
}

function toProposedVerbSummary(d: ProposedVerbDetail): ProposedVerbSummary {
  return {
    slug: d.slug,
    path: d.path,
    description: d.description,
    status: d.status,
    created: d.created,
    proposed_by: d.proposed_by,
  };
}

/**
 * List drafts under `verbs/proposed/`. Returns only files with
 * `status: proposed` (or no status) — declined drafts stay in the
 * directory for history but don't surface in the triage queue.
 */
export async function listProposedVerbs(roleHome: string): Promise<ProposedVerbSummary[]> {
  const dir = path.join(roleHome, 'verbs', 'proposed');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .filter((e) => e.name.toLowerCase() !== 'readme.md')
    .map((e) => path.join(dir, e.name));

  const summaries: ProposedVerbSummary[] = [];
  for (const f of files) {
    const d = await readProposedVerbFile(f, roleHome);
    if (!d) continue;
    if (d.status === 'declined') continue;
    summaries.push(toProposedVerbSummary(d));
  }
  summaries.sort((a, b) => a.slug.localeCompare(b.slug));
  return summaries;
}

export async function loadProposedVerb(roleHome: string, slug: string): Promise<ProposedVerbDetail> {
  const abs = proposedVerbPath(roleHome, slug);
  const detail = await readProposedVerbFile(abs, roleHome);
  if (!detail) {
    throw new TriageNotFoundError(`Proposed verb not found: ${slug}`);
  }
  return detail;
}

// ---- Proposed verbs: mutations -----------------------------------------

/**
 * Replace the body of a proposed-verb draft in place. Frontmatter is
 * preserved. Used by the "Edit before accept" flow when the operator wants
 * to save refinements without promoting yet.
 */
export async function editProposedVerb(
  roleHome: string,
  slug: string,
  body: string,
): Promise<ProposedVerbDetail> {
  const abs = proposedVerbPath(roleHome, slug);
  const existing = await readProposedVerbFile(abs, roleHome);
  if (!existing) {
    throw new TriageNotFoundError(`Proposed verb not found: ${slug}`);
  }
  const content = `${renderFrontmatterMap(existing.frontmatter, VERB_FIELD_ORDER)}\n\n${body.replace(/\s+$/, '')}\n`;
  await atomicWrite(abs, content);

  const refreshed = await readProposedVerbFile(abs, roleHome);
  if (!refreshed) {
    throw new Error(`Failed to re-read proposed verb after edit: ${slug}`);
  }
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [refreshed.path],
    scope: 'triage',
    subject: `edit proposed verb ${slug}`,
  });
  return attachCommitMeta(refreshed, commit);
}

export interface AcceptProposedVerbOptions {
  /** Optional replacement body (operator-refined version). */
  bodyOverride?: string;
}

export interface AcceptProposedVerbResult {
  /** Path the draft was moved to, relative to the role home. */
  movedTo: string;
  /** Whether the CLAUDE.md verbs table was updated. */
  claudeMdUpdated: boolean;
  /** Set when the audit commit landed. */
  commit_sha?: string;
  /** Set when the audit commit was skipped or failed. */
  commit_warning?: string;
}

/**
 * Accept a proposed verb. The transition is:
 *
 *   verbs/proposed/<slug>.md  →  verbs/<slug>.md
 *
 * with frontmatter updated to `status: accepted`. Optionally, the operator
 * can supply a `bodyOverride` to refine the prompt before promotion (the
 * "Edit before accept" flow). The new verb is appended to the verbs table
 * in CLAUDE.md when that table is present and includes the canonical
 * placeholder marker the seed package writes — otherwise we leave
 * CLAUDE.md alone (don't mangle a customised manual) and let the operator
 * add the row by hand.
 *
 * If the live verb already exists (e.g. a second draft of the same slug),
 * we refuse rather than clobber. The operator can rename the draft and
 * try again.
 */
export async function acceptProposedVerb(
  roleHome: string,
  slug: string,
  opts: AcceptProposedVerbOptions = {},
  now: Date = new Date(),
): Promise<AcceptProposedVerbResult> {
  const proposedAbs = proposedVerbPath(roleHome, slug);
  const liveAbs = liveVerbPath(roleHome, slug);

  const existing = await readProposedVerbFile(proposedAbs, roleHome);
  if (!existing) {
    throw new TriageNotFoundError(`Proposed verb not found: ${slug}`);
  }
  if (await fileExists(liveAbs)) {
    throw new TriageValidationError(
      `A live verb already exists at verbs/${slug}.md. Rename the draft or decline this proposal.`,
    );
  }

  const fm = { ...existing.frontmatter };
  fm['status'] = 'accepted';
  fm['accepted_at'] = localDateString(now);
  delete fm['decline_reason'];

  const body = (opts.bodyOverride ?? existing.body).replace(/\s+$/, '');
  const content = `${renderFrontmatterMap(fm, [...VERB_FIELD_ORDER, 'accepted_at'])}\n\n${body}\n`;

  // 1. Write the new live file atomically.
  await atomicWrite(liveAbs, content);
  // 2. Remove the proposed draft (the draft is now redundant — the live
  //    file is the source of truth). The README in verbs/proposed/ says
  //    "If accepted, the operator moves the file" — that's exactly the
  //    move.
  try {
    await fs.unlink(proposedAbs);
  } catch (e) {
    // Best-effort cleanup: if we can't remove the draft, we still moved
    // the verb live. Surface but don't fail.
    if (!isNotFound(e)) throw e;
  }

  // 3. Append a row to CLAUDE.md's verbs table (best-effort).
  const claudeMdUpdated = await appendVerbToClaudeMd(roleHome, slug, existing.description ?? null);

  const rel = path.relative(roleHome, liveAbs);

  // 4. Audit commit. Stage all three potentially-changed paths so the rename
  //    + frontmatter update + CLAUDE.md row land as one operator-attributed
  //    commit. simple-git's `git add` over the deleted proposed file would
  //    NOT stage the deletion, so explicitly stage that path so the commit
  //    records the rename.
  const commitPaths = [rel, path.relative(roleHome, proposedAbs)];
  if (claudeMdUpdated) commitPaths.push('CLAUDE.md');
  const commitBody = [`Promoted verbs/proposed/${slug}.md to verbs/${slug}.md.`];
  if (claudeMdUpdated) commitBody.push('Appended row to CLAUDE.md verbs table.');
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: commitPaths,
    scope: 'triage',
    subject: `accept proposed verb ${slug}`,
    body: commitBody.join('\n'),
  });
  const result: AcceptProposedVerbResult = { movedTo: rel, claudeMdUpdated };
  if (commit.committed && commit.sha) result.commit_sha = commit.sha;
  if (commit.warning) result.commit_warning = commit.warning;
  return result;
}

export async function declineProposedVerb(
  roleHome: string,
  slug: string,
  reason: string,
  now: Date = new Date(),
): Promise<ProposedVerbDetail> {
  if (reason.trim().length === 0) {
    throw new TriageValidationError('Decline reason is required.');
  }
  const abs = proposedVerbPath(roleHome, slug);
  const existing = await readProposedVerbFile(abs, roleHome);
  if (!existing) {
    throw new TriageNotFoundError(`Proposed verb not found: ${slug}`);
  }
  const fm = { ...existing.frontmatter };
  fm['status'] = 'declined';
  fm['decline_reason'] = reason.trim();
  fm['declined_at'] = localDateString(now);
  const content = `${renderFrontmatterMap(fm, [...VERB_FIELD_ORDER, 'declined_at'])}\n\n${existing.body.replace(/\s+$/, '')}\n`;
  await atomicWrite(abs, content);

  const refreshed = await readProposedVerbFile(abs, roleHome);
  if (!refreshed) {
    throw new Error(`Failed to re-read proposed verb after decline: ${slug}`);
  }
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [refreshed.path],
    scope: 'triage',
    subject: `decline proposed verb ${slug}`,
    body: reason.trim(),
  });
  return attachCommitMeta(refreshed, commit);
}

// ---- CLAUDE.md verbs-table append -------------------------------------

/**
 * Append a row to the verbs table in CLAUDE.md. We append immediately
 * before the table-end (which we detect as the first blank line following
 * the table header) so the new verb sits alongside the existing rows.
 *
 * The function returns false (no-op) if CLAUDE.md is missing, doesn't
 * contain the standard verbs table header, or the row already appears.
 * Mangling a customised manual is worse than leaving it alone — the
 * operator can always add the row by hand from the dashboard's success
 * message.
 */
async function appendVerbToClaudeMd(
  roleHome: string,
  slug: string,
  description: string | null,
): Promise<boolean> {
  const abs = path.join(roleHome, 'CLAUDE.md');
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return false;
  }

  const file = `verbs/${slug}.md`;
  if (text.includes(`\`${file}\``)) {
    // Already in the table somewhere — don't duplicate.
    return false;
  }

  const lines = text.split('\n');
  // Find the table header — the seed template uses
  // `| Verb | File | Input Stage | Output Stage |`. Be slightly forgiving:
  // any pipe-row starting with `| Verb |` counts.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\|\s*Verb\s*\|/.test(lines[i] ?? '')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return false;

  // Find the end of the table (first blank line or non-pipe line after the
  // header).
  let insertIdx = headerIdx + 1;
  while (insertIdx < lines.length) {
    const line = lines[insertIdx] ?? '';
    if (line.trim().length === 0 || !line.startsWith('|')) break;
    insertIdx += 1;
  }

  const name = prettifySlug(slug);
  const summary = description && description.trim().length > 0 ? description.trim() : '<unset>';
  const row = `| **${name}** | \`${file}\` | <unset> | ${summary} |`;
  lines.splice(insertIdx, 0, row);
  const newText = lines.join('\n');
  await atomicWrite(abs, newText);
  return true;
}

function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(' ');
}

// ---- misc helpers ------------------------------------------------------

function dateKey(s: string | null): number {
  if (!s) return 0;
  const digits = s.replace(/-/g, '');
  return /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
