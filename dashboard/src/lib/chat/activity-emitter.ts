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
  const rel = `logs/${localDateString(now)}.jsonl`;
  const abs = path.join(roleHome, rel);

  // Build the JSONL record. Field order matches `praxis log` JSONL —
  // timestamp → agent → action → tool → payload extras — so the activity
  // loader and the operator's `tail -f` both see consistent shape.
  const record: Record<string, unknown> = {
    timestamp: localIsoString(now),
    agent: 'chat',
    action: 'tool_call',
    tool: toolName,
  };
  for (const [key, value] of Object.entries(payload)) {
    // Refuse to shadow the conventional fields — preserves the contract that
    // `timestamp`/`agent`/`action`/`tool` always carry the same meaning.
    if (key in record) continue;
    record[key] = value;
  }

  const line = JSON.stringify(record);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, `${line}\n`, 'utf-8');

  return commitChange({
    roleHome,
    actor: 'role',
    filePaths: [rel],
    scope: 'activity',
    subject: `log tool_call ${toolName}`,
  });
}
