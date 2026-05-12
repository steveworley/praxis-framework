import fs from 'node:fs';
import path from 'node:path';

/**
 * Public surface of `praxis log` — the structured-action JSONL logger.
 *
 * Direct replacement for the previous `template/bin/log` Python script. The
 * contract (flag names, JSON shape, output path) matches what role playbooks
 * already invoke, so existing verb files keep working after a one-line
 * rewrite from `bin/log ...` to `praxis log ...`.
 *
 * Marker for the role root is `persona.md` — invariant across every seeded
 * role. The old script walked up looking for a `campaigns/` directory; with
 * the Phase-1.5 framework structure that's no longer the universal marker
 * (roles without campaigns still need to log), so we promoted persona.md to
 * be the canonical root signal.
 */

export interface LogCommandOptions {
  /** Optional campaign id. When set, logs go under `campaigns/{id}/logs/`. */
  campaign?: string;
  /** Agent name (verb / playbook responsible for the action). */
  agent?: string;
  /** Action verb the agent took, e.g. `email_drafted`, `decision`. */
  action?: string;
  /** Optional prospect id — conventional extra. */
  prospect?: string;
  /** Optional short narrative — conventional extra. */
  details?: string;
  /** Optional email/message subject — conventional extra. */
  subject?: string;
  /** When true, print the JSON line that was written to stdout. */
  echo?: boolean;
}

/**
 * Run the log subcommand. Resolves the role root, writes the JSONL entry,
 * and returns when the file has been appended. Throws on failure so the
 * commander wrapper can map the error to a non-zero exit + clean stderr.
 *
 * Pure side-effect-driven: filesystem write + optional stdout echo. The
 * function returns the JSON line that was written so tests can assert
 * against the in-memory shape without re-reading the file.
 */
export async function runLog(
  options: LogCommandOptions,
  extras: readonly string[],
  cwd: string = process.cwd(),
  now: Date = new Date(),
): Promise<{ line: string; logPath: string }> {
  if (!options.action || options.action.length === 0) {
    throw new LogError('--action is required');
  }

  const parsedExtras = parseExtras(extras);

  const root = resolveRoleRoot(cwd);

  const logsDir = options.campaign
    ? path.join(root, 'campaigns', options.campaign, 'logs')
    : path.join(root, 'logs');

  // When a campaign is supplied, the campaign directory must already exist —
  // logging into a non-existent campaign would scatter orphan log files the
  // dashboard never reads. The role-local `logs/` directory is auto-created
  // because there's no equivalent "is this a real campaign?" check available.
  if (options.campaign) {
    const campaignDir = path.dirname(logsDir);
    if (!directoryExists(campaignDir)) {
      throw new LogError(
        `Campaign directory does not exist: ${campaignDir}. Create it before logging, or check the campaign id.`,
      );
    }
  }

  fs.mkdirSync(logsDir, { recursive: true });

  const today = localDateIsoString(now);
  const logPath = path.join(logsDir, `${today}.jsonl`);

  // Field ordering matters for human-readability of the JSONL — timestamp
  // first, then conventional fields in a fixed order, then operator extras
  // in the order they appeared on the command line. Mirrors the Python
  // implementation so dashboard parsers see no shape change.
  const record: Record<string, string> = {
    timestamp: localIsoString(now),
  };
  const flagFields: Array<[string, string | undefined]> = [
    ['agent', options.agent],
    ['action', options.action],
    ['prospect_id', options.prospect],
    ['campaign_id', options.campaign],
    ['details', options.details],
    ['subject', options.subject],
  ];
  for (const [key, value] of flagFields) {
    if (value !== undefined) record[key] = value;
  }
  for (const [key, value] of parsedExtras) {
    if (key in record) {
      process.stderr.write(`warning: extra '${key}' shadowed by flag value\n`);
      continue;
    }
    record[key] = value;
  }

  const line = JSON.stringify(record);
  fs.appendFileSync(logPath, `${line}\n`, 'utf-8');

  if (options.echo) {
    process.stdout.write(`${line}\n`);
  }

  return { line, logPath };
}

/**
 * Thin error class used by the command implementation. The commander wrapper
 * (in index.tsx) catches these and writes the message to stderr + exits
 * non-zero, so the CLI never surfaces a stack trace for operator-facing
 * failures.
 */
export class LogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogError';
  }
}

/**
 * Walk up from `start` looking for a directory containing `persona.md`.
 * That's the framework's canonical role-root marker — every seeded role has
 * one, and only role roots have one at the top level. Throws if we hit the
 * filesystem root without finding it.
 */
function resolveRoleRoot(start: string): string {
  let cur = path.resolve(start);
  // Loop guard: stop once parent equals self (filesystem root).
  while (true) {
    if (fileExists(path.join(cur, 'persona.md'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      throw new LogError(
        `Could not locate a 'persona.md' walking up from ${start}. Run from inside a praxis role directory.`,
      );
    }
    cur = parent;
  }
}

/**
 * Parse trailing `key=value` arguments. Empty keys or pairs missing the
 * separator are both fatal — silently dropping malformed extras would let
 * agents log garbage forever without noticing.
 */
function parseExtras(pairs: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) {
      throw new LogError(`Extra arg must be key=value (got: ${JSON.stringify(p)})`);
    }
    const key = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (key.length === 0) {
      throw new LogError(`Extra arg has empty key: ${JSON.stringify(p)}`);
    }
    out.push([key, value]);
  }
  return out;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function directoryExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Render the local date as `YYYY-MM-DD`. Matches Python's
 * `datetime.now().astimezone().date().isoformat()` — the day boundary is
 * the local boundary, not UTC, so a midnight-PT log lands in the right
 * file regardless of where the operator is.
 */
function localDateIsoString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Render an ISO 8601 string with a local timezone offset (e.g.
 * `2026-05-08T10:23:45+10:00`). Mirrors Python's
 * `datetime.now().astimezone().isoformat(timespec='seconds')`.
 *
 * `Date.prototype.toISOString()` returns UTC with a trailing `Z`, which
 * loses the operator's local clock context — useful when reading logs
 * during a session — so we assemble the offset string by hand.
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
