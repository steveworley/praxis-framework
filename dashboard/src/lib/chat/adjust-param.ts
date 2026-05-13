import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AutonomySurface, Bound } from '@/lib/autonomy-loader.js';
import { commitChange } from '../audit.js';
import { isWriteAllowed } from './autonomy-gate.js';

/**
 * `adjust_param` — the chat tool for `mode: bounded` operator-opened
 * surfaces (see docs/autonomy.md).
 *
 * Shape contract:
 *   - The surface is a YAML file (extension `.yaml` or `.yml`).
 *   - The file's top level is a flat `key: value` map of numeric parameters
 *     (operators usually seed it with defaults). No nesting, no lists.
 *   - The autonomy.yaml entry declares a `bounds:` block — a per-parameter
 *     `{min, max, step?}` map naming exactly the keys the role may adjust.
 *     Parameters not in `bounds` are operator-only; refusal is loud and the
 *     model is expected to escalate if they need to change.
 *
 * Refusal cases (each returns a clear `error` message the model can act on):
 *   - Path not listed in autonomy.yaml (handled by the gate)
 *   - Mode is not `bounded` (handled by the gate; only `full`, `append-only`,
 *     `inline-enrichment`, and `bounded` pass through, and the others are
 *     wrong for this tool)
 *   - File is not a YAML extension
 *   - File missing or unreadable
 *   - autonomy.yaml entry omits `bounds`
 *   - Parameter key not declared in `bounds`
 *   - Value < min, > max, or (when step declared) not step-aligned
 */

const PATH_SAFE_RE = /^[A-Za-z0-9._/-]+$/;

export const AdjustParamInput = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .regex(PATH_SAFE_RE, 'path must contain only [A-Za-z0-9._/-]'),
  key: z
    .string()
    .trim()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'key must be a YAML scalar identifier'),
  value: z.number(),
});
export type AdjustParamArgs = z.infer<typeof AdjustParamInput>;

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
 * Execute a bounded-parameter adjustment. Never throws — failures collapse
 * into `{ok: false, error}` so the chat loop can hand the model a
 * tool_result with `is_error: true`.
 */
export async function executeAdjustParam(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = AdjustParamInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`adjust_param input invalid: ${formatZodError(parsed.error)}`);
  }
  const { path: relPath, key, value } = parsed.data;

  if (!Number.isFinite(value)) {
    return fail(
      `adjust_param: value ${value} for ${relPath}:${key} is not a finite number.`,
    );
  }

  if (!isYamlExtension(relPath)) {
    return fail(
      `adjust_param: ${relPath} is not a YAML file (expected .yaml or .yml). Bounded surfaces are wired for flat YAML key-value files only.`,
    );
  }

  const gate = await isWriteAllowed(roleHome, relPath);
  if (!gate.allowed) return fail(gate.reason);

  if (gate.mode !== 'bounded') {
    return fail(
      `adjust_param: ${relPath} is opened in mode '${gate.mode}', not 'bounded'. Use a different tool or have your operator change the mode.`,
    );
  }
  const surface = gate.surface;
  if (!surface) {
    // Defensive: gate guarantees `surface` is set for bounded surfaces.
    return fail(`adjust_param: ${relPath} has no autonomy.yaml surface entry.`);
  }
  if (!surface.bounds || Object.keys(surface.bounds).length === 0) {
    return fail(
      `adjust_param: ${relPath} is bounded but autonomy.yaml doesn't declare 'bounds'. Ask your operator to add it (a per-parameter map of {min, max, step?}).`,
    );
  }
  const bound = surface.bounds[key];
  if (!bound) {
    const declaredKeys = Object.keys(surface.bounds);
    return fail(
      `adjust_param: key '${key}' is not in ${relPath}'s bounds. Declared bounded keys: ${declaredKeys.join(', ')}.`,
    );
  }
  const rangeError = checkRange(value, bound, relPath, key);
  if (rangeError) return fail(rangeError);

  const absPath = path.join(roleHome, relPath);
  let text: string;
  try {
    text = await fs.readFile(absPath, 'utf-8');
  } catch (error: unknown) {
    return fail(
      `adjust_param: cannot read ${relPath}: ${errorMessage(error)}. The file must exist before adjust_param can update it.`,
    );
  }

  const update = applyValue(text, key, value);
  await atomicWrite(absPath, update.text);

  const data: Record<string, unknown> = {
    path: relPath,
    key,
    new_value: value,
  };
  if (update.previousValue !== undefined) data['previous_value'] = update.previousValue;

  const commitBody = update.previousValue !== undefined
    ? `${key}: ${update.previousValue} -> ${value}`
    : `${key}: ${value} (new)`;
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [relPath],
    scope: 'lib',
    subject: `adjust ${surfaceName(relPath)}:${key}`,
    body: commitBody,
  });

  let summary = update.previousValue !== undefined
    ? `adjusted ${relPath}:${key} ${update.previousValue} → ${value}`
    : `set ${relPath}:${key} = ${value}`;
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
 * Floating-point tolerance for step-alignment checks. Picked an order of
 * magnitude below typical operator-set steps (rare to see step < 1e-4 in
 * operational params) so legitimate values still pass without false rejects.
 */
const STEP_EPSILON = 1e-9;

function checkRange(
  value: number,
  bound: Bound,
  relPath: string,
  key: string,
): string | null {
  if (value < bound.min) {
    return `adjust_param: value ${value} is below min (${bound.min}) for ${relPath}:${key}.`;
  }
  if (value > bound.max) {
    return `adjust_param: value ${value} is above max (${bound.max}) for ${relPath}:${key}.`;
  }
  if (bound.step !== undefined && bound.step > 0) {
    const offset = value - bound.min;
    const ratio = offset / bound.step;
    const rounded = Math.round(ratio);
    if (Math.abs(rounded - ratio) > STEP_EPSILON) {
      return `adjust_param: value ${value} for ${relPath}:${key} isn't a multiple of step ${bound.step} starting at min ${bound.min}.`;
    }
  }
  return null;
}

interface ApplyResult {
  text: string;
  /** Previous value as a number when the key existed and parsed cleanly. */
  previousValue?: number;
}

/**
 * Find the top-level `<key>: <value>` line in the YAML text and replace the
 * value. If the key isn't found, append `<key>: <value>` at the end (with a
 * trailing newline if the file doesn't already end with one).
 *
 * Textual approach by design — staying out of `js-yaml` preserves comments,
 * blank lines, and operator-authored formatting verbatim. The schema is flat
 * so this is straightforward: match a line that starts (after optional
 * leading whitespace that's interpreted as zero indent here because top-level)
 * with `<key>:`, then rebuild the line.
 */
function applyValue(text: string, key: string, value: number): ApplyResult {
  const lines = text.split('\n');
  const keyRe = new RegExp(
    `^(\\s*)${escapeRegex(key)}\\s*:\\s*(.*?)\\s*$`,
  );
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Only match top-level keys (no leading whitespace). A bounded surface
    // is a flat map, so anything indented isn't ours.
    const m = keyRe.exec(line);
    if (!m) continue;
    if ((m[1] ?? '').length > 0) continue;
    const rawValue = (m[2] ?? '').trim();
    const previous = rawValue.length > 0 ? Number.parseFloat(rawValue) : Number.NaN;
    lines[i] = `${key}: ${emitNumber(value)}`;
    const result: ApplyResult = { text: lines.join('\n') };
    if (Number.isFinite(previous)) result.previousValue = previous;
    return result;
  }

  // Not found — append with a newline-terminated trailing line. If the file
  // doesn't end with a newline, add one so the new line lands tidily.
  const trailing = text.endsWith('\n') ? '' : '\n';
  const next = `${text}${trailing}${key}: ${emitNumber(value)}\n`;
  // Strip an extra trailing newline if we already had one — keep file shape
  // close to what the operator authored.
  return { text: next };
}

function emitNumber(value: number): string {
  // Integers stay integers; decimals keep their natural representation.
  // `Number.prototype.toString()` handles both cleanly (no scientific
  // notation for the magnitudes operational params use).
  return value.toString();
}

function isYamlExtension(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return ext === '.yaml' || ext === '.yml';
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.adjust-${randomBytes(4).toString('hex')}.tmp`);
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  applyValue,
  checkRange,
};

export type { AutonomySurface, Bound };
