import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AutonomySurface } from '@/lib/autonomy-loader.js';
import { commitChange } from '../audit.js';
import { isWriteAllowed } from './autonomy-gate.js';

/**
 * `enrich_entry` — the chat tool for `mode: inline-enrichment` operator-opened
 * surfaces (see docs/autonomy.md).
 *
 * Shape contract:
 *   - The surface is a YAML file (extension `.yaml` or `.yml`) — same as
 *     `append_entry`.
 *   - The file has a top-level mapping with a list under a single key, e.g.
 *     `members: [ ... ]`.
 *   - The autonomy.yaml entry declares `root_key` (the list), `unique_by`
 *     (the field on each entry the role uses to look the entry up), and
 *     `soft_fields` (the list of field names the role may update within an
 *     existing entry). All other fields on the entry are hard — the tool
 *     refuses if the role tries to touch them.
 *   - The role can never create new entries via this tool. Structural changes
 *     go through escalation.
 *
 * Refusal cases (each returns a clear `error` message the model can act on):
 *   - Path not listed in autonomy.yaml (handled by the gate)
 *   - Mode is not `inline-enrichment` (handled by the gate; only `full`,
 *     `append-only`, and `inline-enrichment` pass through)
 *   - File is not a YAML extension
 *   - File missing or unreadable
 *   - autonomy.yaml entry omits `soft_fields` or `unique_by`
 *   - File doesn't have the declared `root_key` as a top-level mapping with
 *     a list value
 *   - No entry whose `unique_by` value matches `entry_id` (entry creation is
 *     out of scope for inline-enrichment)
 *   - One of the supplied keys isn't in the surface's `soft_fields` list
 */

const PATH_SAFE_RE = /^[A-Za-z0-9._/-]+$/;

export const EnrichEntryInput = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .regex(PATH_SAFE_RE, 'path must contain only [A-Za-z0-9._/-]'),
  entry_id: z.string().trim().min(1),
  soft_fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .refine((v) => Object.keys(v).length > 0, {
      message: 'soft_fields must be a non-empty object',
    }),
});
export type EnrichEntryArgs = z.infer<typeof EnrichEntryInput>;

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
 * Execute an enrichment. Never throws — failures collapse into
 * `{ok: false, error}` so the chat loop can hand the model a tool_result with
 * `is_error: true`.
 */
export async function executeEnrichEntry(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = EnrichEntryInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`enrich_entry input invalid: ${formatZodError(parsed.error)}`);
  }
  const { path: relPath, entry_id: entryId, soft_fields: softFields } = parsed.data;

  if (!isYamlExtension(relPath)) {
    return fail(
      `enrich_entry: ${relPath} is not a YAML file (expected .yaml or .yml). Inline-enrichment is wired for YAML-list surfaces only.`,
    );
  }

  const gate = await isWriteAllowed(roleHome, relPath);
  if (!gate.allowed) return fail(gate.reason);

  if (gate.mode !== 'inline-enrichment') {
    return fail(
      `enrich_entry: ${relPath} is opened in mode '${gate.mode}', not 'inline-enrichment'. Use a different tool or have your operator change the mode.`,
    );
  }
  const surface = gate.surface;
  if (!surface) {
    // Defensive: gate guarantees `surface` is set for inline-enrichment
    // surfaces, but the type is optional so check anyway.
    return fail(`enrich_entry: ${relPath} has no autonomy.yaml surface entry.`);
  }
  if (!surface.root_key || surface.root_key.length === 0) {
    return fail(
      `enrich_entry: ${relPath} is inline-enrichment but the autonomy.yaml entry doesn't declare 'root_key'. Ask your operator to add it (the top-level YAML key whose list of entries you may enrich).`,
    );
  }
  if (!surface.unique_by || surface.unique_by.length === 0) {
    return fail(
      `enrich_entry: ${relPath} is inline-enrichment but autonomy.yaml doesn't declare 'unique_by'. Ask your operator to add it (the field on each entry that identifies which one you mean).`,
    );
  }
  if (!surface.soft_fields || surface.soft_fields.length === 0) {
    return fail(
      `enrich_entry: ${relPath} is inline-enrichment but the autonomy.yaml entry doesn't declare 'soft_fields'. Ask your operator to add it (the list of field names you may update within an existing entry).`,
    );
  }

  // Reject any incoming field not in the declared soft_fields whitelist.
  // Listed up-front so the model sees the full list in one refusal rather
  // than playing whack-a-mole across calls.
  const allowedSet = new Set(surface.soft_fields);
  const offending: string[] = [];
  for (const k of Object.keys(softFields)) {
    if (!allowedSet.has(k)) offending.push(k);
  }
  if (offending.length > 0) {
    return fail(
      `enrich_entry: field${offending.length > 1 ? 's' : ''} ` +
        offending.map((f) => `'${f}'`).join(', ') +
        ` not in ${relPath}'s soft_fields. Declared soft fields: ${surface.soft_fields.join(', ')}.`,
    );
  }

  const absPath = path.join(roleHome, relPath);
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch (error: unknown) {
    return fail(
      `enrich_entry: cannot read ${relPath}: ${errorMessage(error)}. The file must exist before enrich_entry can update it.`,
    );
  }

  let listInfo: ListInfo;
  try {
    listInfo = locateList(text, surface.root_key);
  } catch (error: unknown) {
    return fail(`enrich_entry: ${relPath}: ${errorMessage(error)}`);
  }

  const matchIndex = listInfo.entries.findIndex(
    (e) => stringifyForCompare(e.fields[surface.unique_by!]) === entryId,
  );
  if (matchIndex < 0) {
    return fail(
      `enrich_entry: no entry with ${surface.unique_by}='${entryId}' in ${relPath}. inline-enrichment can't create entries — file a 'proposed_skill' escalation if you need a new entry shape.`,
    );
  }
  const target = listInfo.entries[matchIndex]!;

  // Compute updates and serialise back to the file:
  //   1. Fields that already exist on the entry get their line replaced
  //      in-place at the existing field's line index.
  //   2. Fields that don't yet exist get collected into a single insertion
  //      block at `target.endLine + 1` so they pack together right after
  //      the entry's last non-blank line.
  const lines = text.split('\n');
  interface Edit {
    /** Inclusive start line index for the lines we're replacing/inserting at. */
    startLine: number;
    /** Exclusive end line index (how many lines to remove starting at startLine). */
    endLine: number;
    /** Replacement lines (no trailing newline; each becomes one file line). */
    replacement: string[];
  }
  const edits: Edit[] = [];
  const appendLines: string[] = [];
  const indent = ' '.repeat(target.continuationIndent);

  for (const [key, value] of Object.entries(softFields)) {
    const yamlValue = emitScalar(value);
    const existingFieldLine = target.fieldLines[key];
    if (existingFieldLine !== undefined) {
      const oldLine = lines[existingFieldLine] ?? '';
      const leading = oldLine.slice(0, oldLine.length - oldLine.trimStart().length);
      edits.push({
        startLine: existingFieldLine,
        endLine: existingFieldLine + 1,
        replacement: [`${leading}${key}: ${yamlValue}`],
      });
    } else {
      appendLines.push(`${indent}${key}: ${yamlValue}`);
    }
  }

  if (appendLines.length > 0) {
    edits.push({
      startLine: target.endLine + 1,
      endLine: target.endLine + 1,
      replacement: appendLines,
    });
  }

  // Apply edits in descending startLine order so later edits don't shift
  // earlier offsets. The append (if any) has the largest startLine
  // (target.endLine + 1) so it's processed first.
  edits.sort((a, b) => b.startLine - a.startLine);
  for (const edit of edits) {
    lines.splice(edit.startLine, edit.endLine - edit.startLine, ...edit.replacement);
  }

  const updated = lines.join('\n');
  await atomicWrite(absPath, updated);

  const fieldsUpdated = Object.keys(softFields);
  const data: Record<string, unknown> = {
    path: relPath,
    entry_id: entryId,
    fields_updated: fieldsUpdated,
    root_key: surface.root_key,
    unique_by: surface.unique_by,
  };

  const commitBody = [
    `${surface.unique_by}: ${entryId}`,
    `Fields: ${fieldsUpdated.join(', ')}`,
  ].join('\n');
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [relPath],
    scope: 'lib',
    subject: `enrich ${surfaceName(relPath)}`,
    body: commitBody,
  });

  let summary = `enriched ${relPath} (${surface.unique_by}=${entryId})`;
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
  /**
   * Line index (0-based, into the whole file's split-by-newline array) where
   * each field's `key: value` line lives. Used to update a field in place.
   */
  fieldLines: Record<string, number>;
  /** Inclusive start line index (the line carrying the entry's `-` dash). */
  startLine: number;
  /** Inclusive end line index — last non-blank line within the entry. */
  endLine: number;
  /** Indent (column) for continuation lines inside this entry. */
  continuationIndent: number;
}

interface ListInfo {
  entries: ParsedEntry[];
}

/**
 * Locate the `root_key: ` block in the YAML text, scan its list entries,
 * and return per-entry metadata (fields + line ranges) so the enrich-step
 * can update specific lines in place.
 *
 * Mirrors append-entry's locator but skips the "where to insert" plumbing —
 * inline-enrichment never inserts at the list level.
 */
function locateList(text: string, rootKey: string): ListInfo {
  const lines = text.split('\n');

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
      `the file does not declare a top-level '${rootKey}:' mapping with a list value.`,
    );
  }

  const entries: ParsedEntry[] = [];
  let i = keyLineIdx + 1;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    if (leading <= keyIndent) break;

    const dashMatch = /^(\s*)-\s+(.*)$/.exec(raw);
    if (!dashMatch) break;
    const dashIndent = dashMatch[1]?.length ?? 0;
    const firstFieldText = dashMatch[2] ?? '';

    const entry: ParsedEntry = {
      fields: {},
      fieldLines: {},
      startLine: i,
      endLine: i,
      continuationIndent: dashIndent + 2,
    };

    // First field is on the dash line itself.
    parseAndRecord(firstFieldText, i, entry);
    let lastNonBlank = i;
    i += 1;

    while (i < lines.length) {
      const next = lines[i] ?? '';
      const nextTrim = next.trim();
      if (nextTrim.length === 0) {
        // Look ahead — does the next non-blank line belong to this entry?
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
        i += 1;
        continue;
      }
      if (nextTrim.startsWith('#')) {
        i += 1;
        continue;
      }
      const nextLeading = next.length - next.trimStart().length;
      if (nextLeading <= dashIndent) break;

      parseAndRecord(next.trim(), i, entry);
      lastNonBlank = i;
      i += 1;
    }
    entry.endLine = lastNonBlank;
    entries.push(entry);
  }

  return { entries };
}

/**
 * Parse a `key: value` fragment and stash both the value and the line where
 * the field lives on the entry. Multi-line block scalars are not introspected
 * — the field's value is recorded as an empty string but its line is still
 * tracked so a later replace edits the leading `key: |` line (the role
 * effectively replaces the block scalar in one step). Same trade-off
 * append-entry makes for unique_by checks.
 */
function parseAndRecord(fragment: string, lineIdx: number, entry: ParsedEntry): void {
  const trimmed = fragment.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
  if (!m) return;
  const key = (m[1] ?? '').trim();
  const value = (m[2] ?? '').trim();
  if (key in entry.fields) return; // first occurrence wins
  entry.fields[key] = stripQuotes(value);
  entry.fieldLines[key] = lineIdx;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const f = value[0];
  const l = value[value.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'")) return value.slice(1, -1);
  return value;
}

/**
 * Emit a YAML scalar for the value. Mirrors append-entry.ts's `emitScalar`
 * but only handles the value shapes inline-enrichment accepts: string,
 * number, boolean, null.
 */
function emitScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `'${String(value)}'`;
    return String(value);
  }
  if (typeof value === 'string') return yamlString(value);
  // Defensive: zod schema only allows string|number|boolean|null, so we
  // never get here. Stringify as a last resort.
  return yamlString(String(value));
}

function yamlString(value: string): string {
  if (value.length === 0) return "''";
  if (value.includes('\n')) {
    const lines = value.split('\n');
    const indent = '      ';
    const block = lines.map((l) => `${indent}${l}`).join('\n');
    return `|\n${block}`;
  }
  const leadingHazard = /^[\s'"#&*!|>%@`?,\[\]{}-]/.test(value);
  const internalHazard = /[:#]\s|^\s|\s$/.test(value);
  const punctOnly =
    /^[-+]?\d+(\.\d+)?$/.test(value) || /^(true|false|null|yes|no|on|off)$/i.test(value);
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
  const tmp = path.join(dir, `.enrich-${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, absPath);
  } catch (error: unknown) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function surfaceName(relPath: string): string {
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
  emitScalar,
  yamlString,
};

export type { AutonomySurface };
