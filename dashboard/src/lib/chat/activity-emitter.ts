import fs from 'node:fs/promises';
import path from 'node:path';

import { commitChange, type CommitResult } from '../audit.js';
import { localDateString, localIsoString } from './time-helpers.js';

/**
 * Auto-emit an activity-log entry for a successful chat tool invocation.
 *
 * The chat dispatcher (`executeTool` in `tools.ts`) calls this once per
 * successful tool call so that the `/activity` page and `/health`'s tool-call
 * distribution see the full tool surface — not just the decisions the model
 * chose to record via `log_decision`.
 *
 * Shape: a single JSONL line appended to `logs/<date>.jsonl`, mirroring the
 * `praxis log` schema (`timestamp`, `agent`, `action`, …). `action` is
 * uniformly `'tool_call'`; the specific tool name lives in a `tool` field so
 * the activity-loader can render and group entries without per-tool branches.
 * A short, human-friendly `headline` (derived from the tool name + payload)
 * sits alongside so the `/activity` renderer — which uses `headline` as the
 * primary display string — has something to show instead of an empty row.
 *
 * Commit story: this is its own commit (`role(activity): log tool_call …`),
 * separate from the artifact commit the underlying tool already wrote. v1
 * accepts the two-commit-per-tool-call trade-off — combining them would
 * require amending an already-landed commit, which is more invasive than the
 * audit benefit warrants.
 *
 * Soft failure: `commitChange` never throws; the JSONL append might. The
 * caller (dispatcher) wraps this call in `try/catch` and attaches a warning
 * to the tool result rather than demoting the tool to a failure — the tool's
 * artifact already landed; the audit-log gap is recoverable.
 */
export async function emitToolActivity(
  roleHome: string,
  toolName: string,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<CommitResult> {
  // Build the JSONL record. Field order matches `praxis log` JSONL —
  // timestamp → agent → action → tool → headline → payload extras — so the
  // activity loader and the operator's `tail -f` both see consistent shape.
  const headline = headlineFor(toolName, payload);
  const record: Record<string, unknown> = {
    agent: 'chat',
    action: 'tool_call',
    tool: toolName,
    headline,
  };
  for (const [key, value] of Object.entries(payload)) {
    // Refuse to shadow the conventional fields — preserves the contract that
    // `timestamp`/`agent`/`action`/`tool`/`headline` always carry the same
    // meaning. Tool payloads don't currently carry a `headline`, but if one
    // ever leaks in we keep the emitter-derived value as the source of truth.
    if (key in record) continue;
    record[key] = value;
  }

  return emitActivity(roleHome, record, {
    scope: 'activity',
    subject: `log tool_call ${toolName}`,
    now,
  });
}

/**
 * Lower-level activity emitter used by self-logging tools whose `action`
 * value is *not* `tool_call` (today: `verb_started`, `verb_completed` — and
 * any future tool that wants its own action-type alongside the generic
 * `tool_call` stream).
 *
 * The emitter:
 *   1. Prepends a `timestamp` (local-ISO, matching `praxis log` shape) to the
 *      record so callers don't have to remember to.
 *   2. Appends a single JSONL line to `logs/<date>.jsonl`.
 *   3. Commits the new line as a `role(<scope>): <subject>` commit.
 *
 * Caller responsibilities:
 *   - Provide `agent` (typically `'chat'`), `action`, and a `headline`
 *     suitable for the activity feed.
 *   - Provide any other action-specific fields (the `verb` slug, the
 *     `outcome`, etc.) on the record. Conventional fields aren't shadowed —
 *     the caller's `agent`/`action`/`headline` win, but `timestamp` is always
 *     emitter-stamped to keep the daily log ordered.
 *
 * Soft failure: same contract as {@link emitToolActivity}. `commitChange`
 * never throws; the JSONL append might. The dispatcher wraps emit in
 * `try/catch` and attaches a warning to the tool result rather than demoting
 * the call to a failure.
 */
export async function emitActivity(
  roleHome: string,
  record: Record<string, unknown>,
  opts: { scope: string; subject: string; body?: string; now?: Date },
): Promise<CommitResult> {
  const now = opts.now ?? new Date();
  const rel = `logs/${localDateString(now)}.jsonl`;
  const abs = path.join(roleHome, rel);

  // Always lead with `timestamp` regardless of what the caller passed —
  // canonical position keeps the JSONL stream parseable by line.
  const stamped: Record<string, unknown> = { timestamp: localIsoString(now) };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'timestamp') continue;
    stamped[key] = value;
  }

  const line = JSON.stringify(stamped);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${line}\n`, 'utf-8');

  return commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: opts.scope,
    subject: opts.subject,
    ...(opts.body ? { body: opts.body } : {}),
  });
}

/**
 * Derive a short, conventional-commit-shaped headline for a tool_call entry.
 *
 * Each branch mirrors the underlying tool's `commitChange({ subject })` — that
 * subject is the canonical short form for the action, so the `/activity` feed
 * stays consistent with the git log. Payload values arrive as `unknown` from
 * the dispatcher's perspective, so every branch narrows defensively; if a
 * required field is missing we fall back to the tool name rather than throwing
 * (the artifact already landed; a degraded headline is preferable to losing
 * the audit row).
 */
export function headlineFor(
  toolName: string,
  payload: Record<string, unknown>,
): string {
  // MCP tools are named `<server>__<method>`. The static-tool switch below
  // would fall through to the default branch and surface the raw underscored
  // shape; the operator-facing `/activity` view reads more naturally with a
  // `mcp:` prefix and a `.` separator.
  if (toolName.includes('__')) {
    const separator = toolName.indexOf('__');
    const server = toolName.slice(0, separator);
    const method = toolName.slice(separator + 2);
    if (server.length > 0 && method.length > 0) {
      return `mcp: ${server}.${method}`;
    }
  }
  switch (toolName) {
    case 'write_memory': {
      const p = stringField(payload, 'path');
      const slug = p ? pathStem(p) : undefined;
      return slug ? `note ${slug}` : toolName;
    }
    case 'archive_memory': {
      const source = stringField(payload, 'source_path');
      const slug = source ? pathStem(source) : undefined;
      return slug ? `archive ${slug}` : toolName;
    }
    case 'consolidate_memory': {
      const newSlug = stringField(payload, 'new_slug');
      const archived = payload['archived'];
      const count = Array.isArray(archived) ? archived.length : undefined;
      if (newSlug && count !== undefined) {
        return `consolidate ${count} entries → ${newSlug}`;
      }
      return toolName;
    }
    case 'create_escalation': {
      const kind = stringField(payload, 'kind');
      const id = stringField(payload, 'id');
      return kind && id ? `file ${kind} — ${id}` : toolName;
    }
    case 'propose_verb': {
      const slug = stringField(payload, 'slug');
      return slug ? `propose ${slug}` : toolName;
    }
    case 'append_entry': {
      const p = stringField(payload, 'path');
      return p ? `append to ${stripExt(p)}` : toolName;
    }
    case 'enrich_entry': {
      const p = stringField(payload, 'path');
      return p ? `enrich ${stripExt(p)}` : toolName;
    }
    case 'adjust_param': {
      const p = stringField(payload, 'path');
      const key = stringField(payload, 'key');
      return p && key ? `adjust ${key} on ${stripExt(p)}` : toolName;
    }
    case 'write_output': {
      const type = stringField(payload, 'type');
      const slug = stringField(payload, 'slug');
      const p = stringField(payload, 'path');
      const target = slug ?? (p ? stripExt(p) : undefined);
      return type && target ? `write ${type}: ${target}` : toolName;
    }
    case 'update_output_status': {
      const status = stringField(payload, 'status');
      const p = stringField(payload, 'path');
      return status && p ? `${status}: ${stripExt(p)}` : toolName;
    }
    default:
      return toolName;
  }
}

function stringField(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Drop a single trailing `.md` (or other ext) from a relative path. */
function stripExt(relPath: string): string {
  const ext = path.extname(relPath);
  return ext.length > 0 ? relPath.slice(0, -ext.length) : relPath;
}

/** Filename stem for a relative path (`memory/notes/foo.md` → `foo`). */
function pathStem(relPath: string): string {
  const base = path.basename(relPath);
  return stripExt(base);
}
