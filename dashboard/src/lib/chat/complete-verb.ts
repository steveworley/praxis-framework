import { z } from 'zod';

import { emitActivity } from './activity-emitter.js';

/**
 * `complete_verb` — close the loop on a `run_verb` invocation by recording
 * the outcome to the activity feed.
 *
 * The pair (`run_verb` → `complete_verb`) forms a clean delegation record:
 * the operator and the dashboard see *which* verb the role used, *what*
 * happened, and *whether* it succeeded — without the LLM having to file a
 * separate `log_decision`.
 *
 * We deliberately do *not* require a matching `verbs/<slug>.md` to exist.
 * Operators rename verbs, draft new ones, or run experimental playbooks
 * inline; the recorder's job is to capture what the role tells us, not to
 * gate on a filesystem match. The slug shape is still enforced so the log
 * isn't polluted with malformed identifiers.
 *
 * Outcome vocabulary is closed: `success`, `partial`, `failed`, `skipped`.
 * Picked over an open string so the activity feed's filter chips stay
 * stable and so the model has a small, opinionated set to choose from.
 *
 * Self-logging: like `run_verb`, this tool emits its own `verb_completed`
 * activity entry, so the dispatcher's auto-instrumentation step skips the
 * generic `tool_call` wrapper.
 */

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export const CompleteVerbInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(SLUG_RE, 'slug must be lowercase letters/digits/hyphens, starting with a letter'),
  outcome: z.enum(['success', 'partial', 'failed', 'skipped']),
  notes: z.string().trim().min(1).max(2000).optional(),
  produced: z.array(z.string().trim().min(1)).optional(),
});
export type CompleteVerbArgs = z.infer<typeof CompleteVerbInput>;

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

export async function executeCompleteVerb(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = CompleteVerbInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`complete_verb input invalid: ${formatZodError(parsed.error)}`);
  }
  const { slug, outcome, notes, produced } = parsed.data;

  const record: Record<string, unknown> = {
    agent: 'chat',
    action: 'verb_completed',
    verb: slug,
    outcome,
    headline: `done: ${slug} (${outcome})`,
  };
  if (notes) record['notes'] = notes;
  if (produced && produced.length > 0) record['produced'] = produced;

  const commit = await emitActivity(roleHome, record, {
    scope: 'verb',
    subject: `complete ${slug} — ${outcome}`,
    now,
  });

  const data: Record<string, unknown> = { slug, outcome };
  if (notes) data['notes'] = notes;
  if (produced && produced.length > 0) data['produced'] = produced;
  let summary = `completed verb ${slug}: ${outcome}`;
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

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
