import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AutonomySurface } from '@/lib/autonomy-loader.js';
import { commitChange } from '../audit.js';
import { isWriteAllowed } from './autonomy-gate.js';

/**
 * `append_entry` — the chat tool for `mode: append-only` operator-opened
 * surfaces (see docs/autonomy.md).
 *
 * Shape contract:
 *   - The surface is a YAML file (extension `.yaml` or `.yml`).
 *   - The file has a top-level mapping with a list under a single key, e.g.
 *     `strategies: [ ... ]`.
 *   - The autonomy.yaml entry declares `root_key` (which list to append to)
 *     and optionally `unique_by` (which field guards against duplicates) and
 *     `max_pending` (how many unreviewed entries can accumulate before the
 *     role must escalate for compaction).
 *   - Pending-entry counting uses a simple `reviewed: false` marker on each
 *     entry. New entries are appended with `reviewed: false` injected if not
 *     present. The operator flips it to `reviewed: true` (manually in their
 *     IDE today) after reviewing.
 *
 * Refusal cases (each returns a clear `error` message the model can act on):
 *   - Path not listed in autonomy.yaml (handled by the gate)
 *   - Mode is not `append-only` (handled by the gate; only `full` and
 *     `append-only` pass through, and `full` is wrong for this tool)
 *   - File is not a YAML extension
 *   - File missing or unreadable
 *   - File doesn't have the declared `root_key` as a top-level mapping with
 *     a list value
 *   - `root_key` / `unique_by` missing from autonomy.yaml when needed
 *   - Entry missing the `unique_by` field (when declared)
 *   - Duplicate value for `unique_by` already present
 *   - `max_pending` reached (model should file an `improvement` escalation
 *     asking for compaction)
 */

const PATH_SAFE_RE = /^[A-Za-z0-9._/-]+$/;

export const AppendEntryInput = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .regex(PATH_SAFE_RE, 'path must contain only [A-Za-z0-9._/-]'),
  entry: z
    .record(z.string(), z.unknown())
    .refine((v) => Object.keys(v).length > 0, {
      message: 'entry must be a non-empty object',
    }),
});
export type AppendEntryArgs = z.infer<typeof AppendEntryInput>;

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

/**
 * Execute an append. Never throws — failures collapse into `{ok: false, error}`
 * so the chat loop can hand the model a tool_result with `is_error: true`.
 */
export async function executeAppendEntry(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = AppendEntryInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`append_entry input invalid: ${formatZodError(parsed.error)}`);
  }
  const { path: relPath, entry } = parsed.data;

  if (!isYamlExtension(relPath)) {
    return fail(
      `append_entry: ${relPath} is not a YAML file (expected .yaml or .yml). Append-only is wired for YAML-list surfaces only.`,
    );
  }

  const gate = await isWriteAllowed(roleHome, relPath);
  if (!gate.allowed) return fail(gate.reason);

  if (gate.mode !== 'append-only') {
    return fail(
      `append_entry: ${relPath} is opened in mode '${gate.mode}', not 'append-only'. Use a different tool or have your operator change the mode.`,
    );
  }
  const surface = gate.surface;
  if (!surface) {
    // Defensive: gate guarantees `surface` is set for append-only surfaces,
    // but the type is optional so check anyway.
    return fail(`append_entry: ${relPath} has no autonomy.yaml surface entry.`);
  }
  if (!surface.root_key || surface.root_key.length === 0) {
    return fail(
      `append_entry: ${relPath} is append-only but the autonomy.yaml entry doesn't declare 'root_key'. Ask your operator to add it (the top-level YAML key whose list you may append to).`,
    );
  }

  const absPath = path.join(roleHome, relPath);
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch (error: unknown) {
    return fail(
      `append_entry: cannot read ${relPath}: ${errorMessage(error)}. The file must exist before append_entry can extend it.`,
    );
  }

  let listInfo: ListInfo;
  try {
    listInfo = locateList(text, surface.root_key);
  } catch (error: unknown) {
    return fail(`append_entry: ${relPath}: ${errorMessage(error)}`);
  }

  // Duplicate detection by unique_by.
  if (surface.unique_by && surface.unique_by.length > 0) {
    const incoming = entry[surface.unique_by];
    if (incoming === undefined || incoming === null || incoming === '') {
      return fail(
        `append_entry: entry is missing the required '${surface.unique_by}' field declared as unique_by in autonomy.yaml.`,
      );
    }
    const existing = listInfo.entries.find(
      (e) => stringifyForCompare(e.fields[surface.unique_by!]) === stringifyForCompare(incoming),
    );
    if (existing) {
      return fail(
        `append_entry: an entry with ${surface.unique_by}='${stringifyForCompare(incoming)}' already exists in ${relPath}. Append-only surfaces don't allow edits — if you need to change an existing entry, file an 'improvement' escalation instead.`,
      );
    }
  }

  // max_pending check (counts entries with `reviewed: false`).
  if (surface.max_pending !== undefined) {
    const pending = listInfo.entries.filter(
      (e) => stringifyForCompare(e.fields['reviewed']) === 'false',
    ).length;
    if (pending >= surface.max_pending) {
      return fail(
        `refused: ${relPath} has ${pending} pending entries (max ${surface.max_pending}). File a compaction escalation first.`,
      );
    }
  }

  // Inject `reviewed: false` if not declared. We don't overwrite — the role
  // is allowed to pass it through explicitly, but the default is unreviewed.
  const enriched: Record<string, unknown> = { ...entry };
  if (!('reviewed' in enriched)) enriched['reviewed'] = false;

  // Append textually. Choosing not to round-trip through a YAML library
  // preserves comments and whitespace in the surrounding file. The trade-off
  // is we own the small emit format for one entry.
  const serialized = serializeEntry(enriched, listInfo.itemIndent, listInfo.itemDashSpacing);
  const updated = insertAfter(text, listInfo.insertAt, serialized, listInfo.needsLeadingNewline);

  await atomicWrite(absPath, updated);

  const count = listInfo.entries.length + 1;
  const summaryParts = [`appended to ${relPath}`];
  if (surface.unique_by && enriched[surface.unique_by] !== undefined) {
    summaryParts.push(`(${surface.unique_by}=${stringifyForCompare(enriched[surface.unique_by])})`);
  }
  const data: Record<string, unknown> = {
    path: relPath,
    count,
    root_key: surface.root_key,
  };
  if (surface.max_pending !== undefined) data['max_pending'] = surface.max_pending;

  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [relPath],
    scope: 'lib',
    subject: `append ${surfaceName(relPath)}`,
    body: surface.unique_by && enriched[surface.unique_by] !== undefined
      ? `${surface.unique_by}: ${stringifyForCompare(enriched[surface.unique_by])}`
      : undefined,
  });

  let summary = summaryParts.join(' ');
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

// ---- YAML list surgery ---------------------------------------------------

interface ParsedEntry {
  /** Inline fields of the entry as raw strings (no nested map parsing). */
  fields: Record<string, string | undefined>;
}

interface ListInfo {
  /** Existing entries' shallow fields, used for unique_by + reviewed counts. */
  entries: ParsedEntry[];
  /**
   * Offset in the original text at which we should insert the new entry.
   * Always at the end of the existing list (before any trailing blank lines
   * inside the list and before the next top-level key or EOF).
   */
  insertAt: number;
  /** True when the text at `insertAt` doesn't already end with a newline. */
  needsLeadingNewline: boolean;
  /**
   * Indent (number of spaces) for an entry's continuation lines — i.e. the
   * column where `key: value` lines start within an entry. Inferred from the
   * first existing entry, defaults to 4 when the list is empty.
   */
  itemIndent: number;
  /**
   * Indent of the leading `- ` dash. Inferred from the first existing entry,
   * defaults to 2 when the list is empty.
   */
  itemDashSpacing: number;
}

/**
 * Locate the `root_key: ` block in the YAML text, scan its list entries,
 * and compute where to insert a new one. Throws with a clear message when
 * the structure isn't what we expect.
 */
function locateList(text: string, rootKey: string): ListInfo {
  const lines = text.split('\n');

  // Find the line `<root_key>:` at column 0 (or any column — but as a
  // top-level mapping key it's almost always at column 0). Accept any
  // leading-whitespace level as long as nested-equivalent.
  const keyRe = new RegExp(`^(\\s*)${escapeRegex(rootKey)}\\s*:\\s*$`);
  let keyLineIdx = -1;
  let keyIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = keyRe.exec(lines[i] ?? '');
    if (m) {
      keyLineIdx = i;
      keyIndent = m[1]?.length ?? 0;
      break;
    }
  }
  if (keyLineIdx < 0) {
    throw new Error(
      `the file does not declare a top-level '${rootKey}:' mapping with a list value. Add the empty list (\`${rootKey}: []\`) is not yet supported; the surface needs an explicit '${rootKey}:' line followed by '- ...' items.`,
    );
  }

  // Walk forward. We want the lines between keyLineIdx+1 and the next
  // line whose indent is <= keyIndent that isn't blank/comment.
  const entries: ParsedEntry[] = [];
  let lastEntryEndLine = keyLineIdx; // line index of the last meaningful line of the list
  let itemDashSpacing = -1;
  let itemIndent = -1;
  let i = keyLineIdx + 1;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    if (leading <= keyIndent) {
      // Top-level key or sibling sequence at the same/outer level ends the list.
      break;
    }

    const dashMatch = /^(\s*)-\s+(.*)$/.exec(raw);
    if (!dashMatch) {
      // A non-dash line inside the list region we don't understand. Stop
      // here and consider this the end of the list to be conservative.
      break;
    }
    const dashIndent = dashMatch[1]?.length ?? 0;
    const firstFieldText = dashMatch[2] ?? '';
    if (itemDashSpacing < 0) {
      itemDashSpacing = dashIndent;
      // Continuation lines inside an entry start two spaces past the dash
      // (consistent with `- key: value` shape). The actual indent of the
      // continuation key matches `dashIndent + 2`.
      itemIndent = dashIndent + 2;
    }

    const entryLines: string[] = [firstFieldText];
    const entryStart = i;
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      const nextTrim = next.trim();
      if (nextTrim.length === 0) {
        // Allow blank lines inside an entry, but cap how greedy we are: if
        // the next non-blank line is at <= dashIndent, the blank line wasn't
        // part of this entry. Peek.
        let j = i + 1;
        let belongs = false;
        while (j < lines.length) {
          const peek = lines[j] ?? '';
          const peekTrim = peek.trim();
          if (peekTrim.length === 0 || peekTrim.startsWith('#')) {
            j += 1;
            continue;
          }
          const peekLeading = peek.length - peek.trimStart().length;
          if (peekLeading > dashIndent) belongs = true;
          break;
        }
        if (!belongs) break;
        entryLines.push(next);
        i += 1;
        continue;
      }
      if (nextTrim.startsWith('#')) {
        i += 1;
        continue;
      }
      const nextLeading = next.length - next.trimStart().length;
      if (nextLeading <= dashIndent) {
        // Sibling entry or end of list.
        break;
      }
      entryLines.push(next);
      i += 1;
    }

    entries.push({ fields: parseEntryFields(entryLines) });
    lastEntryEndLine = i - 1;
    // `i` now points at the next entry (or list-ender / blank).
    // Skip trailing blank lines inside the list; we'll continue the outer
    // loop to either see another entry or hit the list boundary.
    void entryStart;
  }

  // Defaults when the list is empty.
  if (itemDashSpacing < 0) {
    itemDashSpacing = keyIndent + 2;
    itemIndent = itemDashSpacing + 2;
  }

  // Compute insertAt: end of the last entry's last non-blank line, on its
  // newline terminator.
  let insertAt: number;
  let needsLeadingNewline = false;
  if (entries.length === 0) {
    // Insert directly after the `<root_key>:` line.
    insertAt = endOfLine(text, keyLineIdx);
    needsLeadingNewline = false; // newline already present from the key line break
  } else {
    insertAt = endOfLine(text, lastEntryEndLine);
    needsLeadingNewline = false;
  }

  return { entries, insertAt, needsLeadingNewline, itemIndent, itemDashSpacing };
}

/**
 * Parse a single entry's lines into shallow fields. Each line is expected to
 * be `key: value`; the first line was post-`- ` already. Values are stored
 * raw (quotes preserved) so the duplicate check can normalise them later.
 *
 * Multi-line block scalars (`key: |`) and nested mappings collapse to a
 * single empty-string value — we don't introspect them for unique_by checks.
 * That's acceptable because unique_by is almost always a short identifier
 * scalar (id, slug, etc).
 */
function parseEntryFields(lines: string[]): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = (m[1] ?? '').trim();
    const value = (m[2] ?? '').trim();
    // First occurrence wins (top-level entry fields).
    if (key in fields) continue;
    fields[key] = stripQuotes(value);
  }
  return fields;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const f = value[0];
  const l = value[value.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'")) return value.slice(1, -1);
  return value;
}

function endOfLine(text: string, lineIdx: number): number {
  let pos = 0;
  let line = 0;
  while (line < lineIdx && pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) return text.length;
    pos = nl + 1;
    line += 1;
  }
  const nl = text.indexOf('\n', pos);
  if (nl < 0) return text.length;
  return nl + 1; // past the newline so insertion lands on a fresh line
}

function insertAfter(
  text: string,
  offset: number,
  block: string,
  needsLeadingNewline: boolean,
): string {
  const head = text.slice(0, offset);
  const tail = text.slice(offset);
  const prefix = needsLeadingNewline && !head.endsWith('\n') ? '\n' : '';
  return `${head}${prefix}${block}${tail}`;
}

/**
 * Emit one list entry as YAML text. Format:
 *
 *   <dashIndent>- key1: value1
 *   <itemIndent>key2: value2
 *
 * Each call adds a trailing newline so successive appends stack tidily.
 * Field order follows the input object's insertion order; we put the
 * unique-by-style fields first by convention but don't enforce it here —
 * the model controls ordering.
 */
function serializeEntry(
  entry: Record<string, unknown>,
  itemIndent: number,
  dashIndent: number,
): string {
  const itemPad = ' '.repeat(itemIndent);
  const dashPad = ' '.repeat(dashIndent);
  const keys = Object.keys(entry);
  if (keys.length === 0) return '';

  const lines: string[] = [];
  let first = true;
  for (const key of keys) {
    const value = entry[key];
    const yamlValue = emitScalar(value, itemIndent);
    const prefix = first ? `${dashPad}- ` : itemPad;
    lines.push(`${prefix}${key}: ${yamlValue}`);
    first = false;
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Emit a YAML scalar for the value. Strings get quoted when they contain
 * YAML-special characters or look ambiguous; booleans/numbers/null pass
 * through as-is. Arrays and nested objects are emitted as JSON-style inline
 * literals — readable enough for entries that mostly hold scalars, and YAML
 * 1.2 accepts flow collections.
 */
function emitScalar(value: unknown, _itemIndent: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `'${String(value)}'`;
    return String(value);
  }
  if (typeof value === 'string') {
    return yamlString(value);
  }
  // Arrays + objects — use JSON-style flow notation. Sufficient for
  // common append-only entry shapes (tags, small nested confidence maps).
  try {
    return JSON.stringify(value);
  } catch {
    return "''";
  }
}

function yamlString(value: string): string {
  if (value.length === 0) return "''";
  // Multi-line strings get folded into block scalars to stay readable.
  if (value.includes('\n')) {
    const lines = value.split('\n');
    const indent = '      '; // 6 spaces — covers the typical itemIndent+2
    const block = lines.map((l) => `${indent}${l}`).join('\n');
    return `|\n${block}`;
  }
  // Plain scalar safe? Avoid YAML-special leading chars and characters that
  // change parsing (`:` followed by space, `#`, etc).
  const leadingHazard = /^[\s'"#&*!|>%@`?,\[\]{}-]/.test(value);
  const internalHazard = /[:#]\s|^\s|\s$/.test(value);
  const punctOnly = /^[-+]?\d+(\.\d+)?$/.test(value) || /^(true|false|null|yes|no|on|off)$/i.test(value);
  if (leadingHazard || internalHazard || punctOnly) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringifyForCompare(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isYamlExtension(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === '.yaml' || ext === '.yml';
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.append-${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, absPath);
  } catch (error: unknown) {
    // Best effort cleanup so a failed rename doesn't leave a tmp file behind.
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function surfaceName(relPath: string): string {
  // `lib/research-strategies.yaml` -> `research-strategies`
  const base = path.basename(relPath);
  const stem = base.replace(/\.(yaml|yml)$/i, '');
  return stem.length > 0 ? stem : relPath;
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

/** Test seam: hand-pick internals to assert directly. */
export const _internals = {
  locateList,
  serializeEntry,
  yamlString,
  emitScalar,
};

// Re-export the surface type so callers can name it without reaching for
// the autonomy-loader module.
export type { AutonomySurface };
