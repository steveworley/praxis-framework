import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { commitChange, type CommitResult } from '../audit.js';
import { executeAppendEntry } from './append-entry.js';
import { isWriteAllowed } from './autonomy-gate.js';
import {
  executeUpdateOutputStatus,
  executeWriteOutput,
} from './output-tools.js';

/**
 * Tool executors for the chat surface. Each executor:
 *
 *   1. Validates input via Zod (refuses on shape mismatch).
 *   2. Computes the relative path it intends to write.
 *   3. Consults `isWriteAllowed()` — refuses if gated.
 *   4. Refuses if the target file already exists (memory + verbs are
 *      append-only at the file level; escalations are id-unique).
 *   5. Writes the file with a small, consistent frontmatter shape.
 *
 * Refusals return `{error: <message>}`; the message-endpoint loop translates
 * that into an Anthropic `tool_result` block with `is_error: true`. The model
 * sees the message and can pick a different action.
 *
 * Slug + filename safety: every user-controlled string is run through
 * `slugify()` before becoming a path segment. The autonomy gate also does a
 * path-traversal check on the final relative path as a defense-in-depth.
 */

// ---- Zod schemas (mirror tool-schemas.ts) -------------------------------

const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]*$/;

export const WriteMemoryInput = z.object({
  category: z
    .string()
    .trim()
    .min(1)
    .regex(CATEGORY_RE, 'category must be lowercase letters/digits/hyphens, starting with a letter'),
  title: z.string().trim().min(1).max(160),
  body: z.string().min(1),
});
export type WriteMemoryArgs = z.infer<typeof WriteMemoryInput>;

export const CreateEscalationInput = z.object({
  kind: z.enum(['help', 'improvement', 'proposed_skill']),
  summary: z.string().trim().min(1).max(200),
  body: z.string().min(1),
  urgency: z.enum(['low', 'normal', 'high']).optional(),
  agent_context: z.string().trim().min(1).max(80).optional(),
  proposed_skill_path: z.string().trim().min(1).optional(),
});
export type CreateEscalationArgs = z.infer<typeof CreateEscalationInput>;

export const ProposeVerbInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(SLUG_RE, 'slug must be lowercase letters/digits/hyphens, starting with a letter'),
  description: z.string().trim().min(1).max(200),
  body: z.string().min(1),
});
export type ProposeVerbArgs = z.infer<typeof ProposeVerbInput>;

export const LogDecisionInput = z.object({
  decision_type: z.string().trim().min(1).max(80),
  chosen: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  considered: z.array(z.string().trim().min(1)).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  campaign: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'campaign must be a safe identifier')
    .optional(),
  extras: z.record(z.string(), z.string()).optional(),
});
export type LogDecisionArgs = z.infer<typeof LogDecisionInput>;

// ---- Result types -------------------------------------------------------

export interface ToolSuccess {
  ok: true;
  /** A short human-friendly summary the UI can show inline. */
  summary: string;
  /** Structured result the model sees in its tool_result. */
  data: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  error: string;
}

export type ToolResult = ToolSuccess | ToolFailure;

// ---- write_memory --------------------------------------------------------

export async function executeWriteMemory(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = WriteMemoryInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`write_memory input invalid: ${formatZodError(parsed.error)}`);
  }
  const { category, title, body } = parsed.data;

  const slug = slugify(title);
  if (slug.length === 0) {
    return fail('write_memory: title slugified to an empty string.');
  }

  const rel = `memory/${category}/${slug}.md`;
  const gate = await isWriteAllowed(roleHome, rel);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, rel);
  if (await fileExists(abs)) {
    return fail(
      `write_memory: ${rel} already exists. Memory entries are append-only at the file level — pick a different title or update the existing file via your operator.`,
    );
  }

  const today = todayLocalDate();
  const content = renderFrontmatter([
    ['title', title],
    ['created', today],
    ['updated', today],
  ]) + `\n\n# ${title}\n\n${body.trimEnd()}\n`;

  await ensureDirAndWrite(abs, content);
  const success = ok(`wrote ${rel}`, { path: rel, created: today });
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: 'memory',
    subject: `note ${slug}`,
    body: `Category: ${category}`,
  });
  return withAuditCommit(success, commit);
}

// ---- create_escalation ---------------------------------------------------

export async function executeCreateEscalation(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = CreateEscalationInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`create_escalation input invalid: ${formatZodError(parsed.error)}`);
  }
  const data = parsed.data;

  const date = localDateString(now);
  const slug = slugify(data.summary).slice(0, 60) || 'untitled';
  const random = randomBytes(2).toString('hex');
  const id = `${date}-${random}-${slug}`;
  const rel = `escalations/${id}.md`;

  const gate = await isWriteAllowed(roleHome, rel);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, rel);
  if (await fileExists(abs)) {
    // Vanishingly unlikely (random suffix + slug + date), but the existence
    // check keeps the contract honest.
    return fail(`create_escalation: ${rel} already exists.`);
  }

  const fmFields: Array<[string, string]> = [
    ['kind', data.kind],
    ['urgency', data.urgency ?? 'normal'],
    ['created', date],
    ['agent_context', data.agent_context ?? 'chat'],
    ['status', 'open'],
  ];
  if (data.proposed_skill_path) {
    fmFields.splice(4, 0, ['proposed_skill', data.proposed_skill_path]);
  }

  const content =
    renderFrontmatter(fmFields) +
    `\n\n# ${data.summary}\n\n${data.body.trimEnd()}\n`;

  await ensureDirAndWrite(abs, content);
  const success = ok(`filed ${data.kind} escalation: ${data.summary}`, {
    path: rel,
    id,
    kind: data.kind,
  });
  const summarySlug = slugify(data.summary).slice(0, 60) || 'untitled';
  const commitBody = [
    `Kind: ${data.kind}`,
    `Urgency: ${data.urgency ?? 'normal'}`,
  ].join('\n');
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: 'escalation',
    subject: `file ${data.kind} — ${summarySlug}`,
    body: commitBody,
  });
  return withAuditCommit(success, commit);
}

// ---- propose_verb --------------------------------------------------------

export async function executeProposeVerb(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = ProposeVerbInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`propose_verb input invalid: ${formatZodError(parsed.error)}`);
  }
  const { slug, description, body } = parsed.data;

  // Don't propose verbs that already live in verbs/.
  const livePath = path.join(roleHome, 'verbs', `${slug}.md`);
  if (await fileExists(livePath)) {
    return fail(
      `propose_verb: a verb named '${slug}' already exists at verbs/${slug}.md. File an 'improvement' escalation to extend it instead.`,
    );
  }

  const rel = `verbs/proposed/${slug}.md`;
  const gate = await isWriteAllowed(roleHome, rel);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, rel);
  if (await fileExists(abs)) {
    return fail(
      `propose_verb: ${rel} already exists. Don't clobber an in-flight proposal — pick a different slug or wait for the operator's review.`,
    );
  }

  const date = localDateString(now);
  const content =
    renderFrontmatter([
      ['description', description],
      ['proposed_by', 'chat'],
      ['created', date],
      ['status', 'proposed'],
    ]) + `\n\n${body.trimEnd()}\n`;

  await ensureDirAndWrite(abs, content);
  const success = ok(`proposed verb: ${slug}`, { path: rel, slug });
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: 'verb',
    subject: `propose ${slug}`,
  });
  return withAuditCommit(success, commit);
}

// ---- log_decision --------------------------------------------------------

export async function executeLogDecision(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = LogDecisionInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`log_decision input invalid: ${formatZodError(parsed.error)}`);
  }
  const data = parsed.data;

  const rel = data.campaign
    ? `campaigns/${data.campaign}/logs/${localDateString(now)}.jsonl`
    : `logs/${localDateString(now)}.jsonl`;

  const gate = await isWriteAllowed(roleHome, rel);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, rel);

  // For campaign-scoped logs, refuse if the campaign dir doesn't exist —
  // mirrors `praxis log`'s behaviour to avoid scattering orphan log dirs.
  if (data.campaign) {
    const campaignDir = path.join(roleHome, 'campaigns', data.campaign);
    if (!(await dirExists(campaignDir))) {
      return fail(
        `log_decision: campaign directory does not exist: campaigns/${data.campaign}/. Create it first or omit the campaign.`,
      );
    }
  }

  // Match `praxis log`'s JSONL field order exactly so dashboard parsers
  // (which read both surfaces) see no shape change.
  const record: Record<string, string> = {
    timestamp: localIsoString(now),
    agent: 'chat',
    action: 'decision',
  };
  if (data.campaign) record['campaign_id'] = data.campaign;
  record['decision_type'] = data.decision_type;
  record['chosen'] = data.chosen;
  record['rationale'] = data.rationale;
  if (data.considered && data.considered.length > 0) {
    record['considered'] = data.considered.join(', ');
  }
  if (data.confidence) record['confidence'] = data.confidence;
  if (data.extras) {
    for (const [k, v] of Object.entries(data.extras)) {
      if (k in record) continue; // refuse to shadow conventional fields
      record[k] = v;
    }
  }

  const line = JSON.stringify(record);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${line}\n`, 'utf-8');

  const success = ok(`logged decision: ${data.decision_type}`, {
    logged: true,
    path: rel,
  });
  const decisionBody: string[] = [`Chosen: ${data.chosen}`];
  if (data.confidence) decisionBody.push(`Confidence: ${data.confidence}`);
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: 'decision',
    subject: `log ${data.decision_type}`,
    body: decisionBody.join('\n'),
  });
  return withAuditCommit(success, commit);
}

// ---- dispatch + helpers --------------------------------------------------

export type ToolName =
  | 'write_memory'
  | 'create_escalation'
  | 'propose_verb'
  | 'append_entry'
  | 'log_decision'
  | 'write_output'
  | 'update_output_status';

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'write_memory',
  'create_escalation',
  'propose_verb',
  'append_entry',
  'log_decision',
  'write_output',
  'update_output_status',
]);

/**
 * Dispatch a tool call. Always returns a ToolResult — never throws. The
 * caller (the tool-use loop) translates ok/fail into the Anthropic
 * tool_result block shape.
 */
export async function executeTool(
  name: string,
  input: unknown,
  roleHome: string,
): Promise<ToolResult> {
  if (!KNOWN_TOOLS.has(name)) {
    return fail(`Unknown tool: ${name}`);
  }
  try {
    switch (name as ToolName) {
      case 'write_memory':
        return await executeWriteMemory(roleHome, input);
      case 'create_escalation':
        return await executeCreateEscalation(roleHome, input);
      case 'propose_verb':
        return await executeProposeVerb(roleHome, input);
      case 'append_entry':
        return await executeAppendEntry(roleHome, input);
      case 'log_decision':
        return await executeLogDecision(roleHome, input);
      case 'write_output':
        return await executeWriteOutput(roleHome, input);
      case 'update_output_status':
        return await executeUpdateOutputStatus(roleHome, input);
    }
  } catch (e: unknown) {
    return fail(`Tool ${name} threw: ${errorMessage(e)}`);
  }
}

function ok(summary: string, data: Record<string, unknown>): ToolSuccess {
  return { ok: true, summary, data };
}

/**
 * Fold an audit-commit result into the tool's success envelope:
 *   - on a successful commit, append `· <short-sha>` to the summary and stash
 *     `commit_sha` / `commit_short_sha` in `data` for the chat UI to render
 *   - on a skipped/failed commit, append `(commit skipped: <reason>)` to the
 *     summary and stash `commit_warning` so the model can see the gap.
 *
 * The disk write already succeeded before this fold runs — we never demote a
 * `ToolSuccess` to a failure because the audit log couldn't be written.
 */
function withAuditCommit(success: ToolSuccess, commit: CommitResult): ToolSuccess {
  const data = { ...success.data };
  let summary = success.summary;
  if (commit.committed && commit.sha) {
    data['commit_sha'] = commit.sha;
    if (commit.shortSha) data['commit_short_sha'] = commit.shortSha;
    summary = `${success.summary} · ${commit.shortSha ?? commit.sha.slice(0, 7)}`;
  } else if (commit.warning) {
    data['commit_warning'] = commit.warning;
    summary = `${success.summary} (${commit.warning})`;
  }
  return { ok: true, summary, data };
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Slugify a human-readable string into a safe filename segment. Lowercases,
 * replaces non-[a-z0-9-] runs with single hyphens, trims leading/trailing
 * hyphens. Returns an empty string if nothing slugifiable remains — the
 * caller decides what to do (memory rejects empty; escalation falls back).
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function renderFrontmatter(fields: Array<[string, string]>): string {
  const lines = ['---'];
  for (const [k, v] of fields) {
    lines.push(`${k}: ${quoteIfNeeded(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  // YAML special chars + multiline values need quoting; single-line plain
  // ASCII passes through. We never write multi-line values into frontmatter
  // here, so the rule is: quote on colon, leading whitespace, or quotes.
  if (/^[\s'"#&*!|>%@`\-?,[\]{}]/.test(value) || /[:#]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function ensureDirAndWrite(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf-8');
}

function localDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function todayLocalDate(): string {
  return localDateString(new Date());
}

/**
 * Local ISO 8601 with timezone offset (matches `praxis log` JSONL shape).
 */
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
