import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { emitActivity } from './activity-emitter.js';

/**
 * `run_verb` — make verb invocation a first-class, audit-trail-shaped event.
 *
 * The LLM used to read verb playbooks (`verbs/<slug>.md`) inline as part of
 * its prompt; nothing in the activity feed ever reflected which verb the
 * role actually used. Calling this tool turns verb use into a named,
 * audited delegation:
 *
 *   1. Resolve `verbs/<slug>.md` (live, not proposed).
 *   2. Strip frontmatter, capture the optional `description` field for the
 *      log entry.
 *   3. Append a `verb_started` JSONL line to `logs/<date>.jsonl`.
 *   4. Commit that line as `role(verb): start <slug>`.
 *   5. Return the prose body so the LLM can use it as the next set of
 *      instructions — same content it would have read inline, but now with
 *      a trail.
 *
 * Refusal cases (each returns a clear `error` the model can act on):
 *   - Slug shape invalid (must match kebab-case `SLUG_RE`).
 *   - No live verb at `verbs/<slug>.md`.
 *   - Verb exists only at `verbs/proposed/<slug>.md` (the operator must
 *     accept the proposal via /triage before it can be run).
 *
 * Self-logging: this tool emits its own `verb_started` activity entry, so
 * the dispatcher's auto-instrumentation step skips the generic `tool_call`
 * wrapper (see the exemption set in `tools.ts:executeTool()`).
 */

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export const RunVerbInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(SLUG_RE, 'slug must be lowercase letters/digits/hyphens, starting with a letter'),
});
export type RunVerbArgs = z.infer<typeof RunVerbInput>;

export interface ToolSuccess {
  ok: true;
  summary: string;
  data: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  error: string;
}

export type ToolResult = ToolSuccess | ToolFailure;

export async function executeRunVerb(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = RunVerbInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`run_verb input invalid: ${formatZodError(parsed.error)}`);
  }
  const { slug } = parsed.data;

  const liveRel = path.join('verbs', `${slug}.md`);
  const liveAbs = path.join(roleHome, liveRel);

  let text: string;
  try {
    text = await fs.readFile(liveAbs, 'utf-8');
  } catch {
    // Distinguish "verb proposed but not accepted" from "no such verb" — the
    // refusal copy steers the operator-facing model toward the right next
    // action (accept via triage vs. file a propose_verb).
    const proposedAbs = path.join(roleHome, 'verbs', 'proposed', `${slug}.md`);
    if (await fileExists(proposedAbs)) {
      return fail(
        `run_verb: '${slug}' exists only as a proposal at verbs/proposed/${slug}.md. ` +
          'It must be accepted via /triage before it can be run — surface this to your operator.',
      );
    }
    return fail(
      `run_verb: no live verb at verbs/${slug}.md. Check the slug, or propose the verb via propose_verb if it does not yet exist.`,
    );
  }

  const { description, body } = stripFrontmatter(text);

  const record: Record<string, unknown> = {
    agent: 'chat',
    action: 'verb_started',
    verb: slug,
    headline: `start: ${slug}`,
  };
  if (description) record['description'] = description;

  const commit = await emitActivity(roleHome, record, {
    scope: 'verb',
    subject: `start ${slug}`,
    now,
  });

  const data: Record<string, unknown> = { slug, body };
  if (description) data['description'] = description;
  let summary = `started verb ${slug}`;
  if (commit.committed && commit.sha) {
    data['commit_sha'] = commit.sha;
    if (commit.shortSha) data['commit_short_sha'] = commit.shortSha;
    summary = `${summary} · ${commit.shortSha ?? commit.sha.slice(0, 7)}`;
  } else if (commit.warning) {
    data['commit_warning'] = commit.warning;
    summary = `${summary} (${commit.warning})`;
  }
  return { ok: true, summary, data };
}

/**
 * Strip a leading YAML frontmatter block from the verb file and pull the
 * optional `description:` field out for the activity log.
 *
 * The chat surface only needs `description` (used for the log entry's
 * context line); everything else in the frontmatter is a hint for the
 * /triage and /role views, not for the LLM's runtime. Returns the body with
 * the frontmatter excised so the model receives only the prose it should
 * follow.
 */
export function stripFrontmatter(text: string): { description: string | undefined; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!match) return { description: undefined, body: text };
  const block = match[1] ?? '';
  const body = match[2] ?? '';
  let description: string | undefined;
  for (const rawLine of block.split('\n')) {
    const m = /^\s*description\s*:\s*(.+?)\s*$/i.exec(rawLine);
    if (m) {
      description = stripWrappingQuotes((m[1] ?? '').trim());
      break;
    }
  }
  return { description, body };
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
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

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
