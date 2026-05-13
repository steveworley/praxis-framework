import path from 'node:path';

import { loadAutonomy, type AutonomyMode, type AutonomySurface } from '@/lib/autonomy-loader.js';

/**
 * Surfaces that are constitutional — the model may NEVER edit these via tool
 * calls, regardless of what `lib/autonomy.yaml` says. Hard-coded as a safety
 * net even if autonomy.yaml is malformed. Patterns:
 *   - Plain string: matched exactly against the relative path
 *   - Trailing `/`: directory prefix match
 *   - `verbs/<file>.md`: any direct .md child of verbs/ (NOT under verbs/proposed/)
 */
const CONSTITUTIONAL_PATHS: readonly string[] = [
  'persona.md',
  'CLAUDE.md',
  'lib/customers.yaml',
  'lib/compliance.yaml',
  'lib/autonomy.yaml',
  'lib/tools.yaml',
];

/**
 * Surfaces that are implicitly autonomous regardless of autonomy.yaml — these
 * are the role's own working surfaces where the framework already grants
 * autonomy as the default. Memory, escalations, verbs/proposed/, logs, and
 * the output taxonomy.
 *
 * `logs/` is autonomous because logging is the audit primitive — gating it
 * defeats the whole point of having an audit trail.
 *
 * `output/` is autonomous because it is the role's work product surface —
 * every entry is shaped by the framework's typed taxonomy (document, draft,
 * record, plan, reference) and lives behind closed-enum status transitions,
 * so the write tools enforce structure without needing per-surface gating.
 */
const IMPLICIT_AUTONOMOUS_PREFIXES: readonly string[] = [
  'memory/',
  'escalations/',
  'verbs/proposed/',
  'logs/',
  'output/',
];

const NULL_BYTE = String.fromCharCode(0);

export interface WriteAllowed {
  allowed: true;
  mode: AutonomyMode;
  /**
   * The surface entry from autonomy.yaml when one matched. Absent when the
   * write landed on an implicit-autonomous prefix (memory/, escalations/,
   * verbs/proposed/, logs/, campaigns/<id>/logs/) — those don't carry an
   * autonomy.yaml entry. Callers that need surface-level config (e.g. the
   * `append_entry` tool reading `root_key` / `unique_by` / `max_pending`)
   * check this field.
   */
  surface?: AutonomySurface;
}

export interface WriteRefused {
  allowed: false;
  reason: string;
}

export type WriteDecision = WriteAllowed | WriteRefused;

/**
 * Decide whether the model's tool may write to `relPath` (relative to the
 * role home). Returns a tagged decision: on `allowed: true` it includes the
 * resolved mode (caller can use this for inline-enrichment warnings, etc).
 *
 * Decision order:
 *   1. Path safety — refuse traversal / absolute paths first.
 *   2. Constitutional list — hard refuse (the "never via tools" line).
 *   3. Implicit autonomous prefixes — allow with mode `full`, no yaml lookup
 *      needed (memory/, escalations/, verbs/proposed/, logs/, and
 *      per-campaign logs).
 *   4. autonomy.yaml lookup — match by prefix or exact path. Modes `full`,
 *      `append-only`, and `inline-enrichment` are allowed (the surface is
 *      returned so the caller can enforce per-mode rules). `gated` is
 *      refused outright; `bounded` is refused (no per-mode enforcement yet).
 *   5. Default deny — anything not explicitly opened is gated.
 */
export async function isWriteAllowed(
  roleHome: string,
  relPath: string,
): Promise<WriteDecision> {
  if (!isPathSafe(relPath)) {
    return {
      allowed: false,
      reason: `Refusing unsafe path: ${relPath}`,
    };
  }

  const normalized = normalizeRelPath(relPath);

  if (isConstitutional(normalized)) {
    return {
      allowed: false,
      reason: `Refusing to write ${normalized}: constitutional surface, operator-only.`,
    };
  }

  if (isImplicitlyAutonomous(normalized)) {
    return { allowed: true, mode: 'full' };
  }

  const autonomy = await loadAutonomy(roleHome);
  const surface = autonomy?.surfaces.find((s) => surfaceMatches(s.path, normalized));
  if (!surface) {
    return {
      allowed: false,
      reason: `Refusing to write ${normalized}: surface is not opened in lib/autonomy.yaml. File an escalation instead.`,
    };
  }
  if (surface.mode === 'full') {
    return { allowed: true, mode: 'full', surface };
  }
  if (surface.mode === 'append-only') {
    // The caller (the `append_entry` tool) is responsible for enforcing the
    // per-mode rules — max_pending, unique_by, root_key shape. The gate only
    // says "this surface is open for appends; here's its config".
    return { allowed: true, mode: 'append-only', surface };
  }
  if (surface.mode === 'inline-enrichment') {
    // The caller (the `enrich_entry` tool) enforces the per-mode rules —
    // soft_fields whitelist, entry lookup by unique_by, no entry creation.
    // The gate just says "this surface is open for soft-field updates;
    // here's its config".
    return { allowed: true, mode: 'inline-enrichment', surface };
  }
  if (surface.mode === 'gated') {
    return {
      allowed: false,
      reason: `Refusing to write ${normalized}: surface is gated. File an escalation instead.`,
    };
  }
  // bounded — declared in the autonomy model but not yet wired through the
  // chat tool surface. Refuse with a clear message until it earns dedicated
  // enforcement.
  return {
    allowed: false,
    reason: `Refusing to write ${normalized}: surface is in mode '${surface.mode}', which is not yet supported via the chat tool surface. File an escalation instead.`,
  };
}

function isPathSafe(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (path.isAbsolute(rel)) return false;
  // Reject any segment that's `..` (would escape the role home).
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === '..' || s === '.')) return false;
  // Reject embedded null bytes — they terminate path strings in some
  // syscalls, which is a classic path-traversal vector.
  if (rel.indexOf(NULL_BYTE) !== -1) return false;
  return true;
}

function normalizeRelPath(rel: string): string {
  return rel.split(path.sep).join('/').replace(/^\/+/, '');
}

function isConstitutional(normalized: string): boolean {
  for (const entry of CONSTITUTIONAL_PATHS) {
    if (normalized === entry) return true;
  }
  // Direct .md child of verbs/ (excluding verbs/proposed/) — covers verb
  // playbooks that already exist as part of the role's constitution.
  if (normalized.startsWith('verbs/') && !normalized.startsWith('verbs/proposed/')) {
    if (normalized.endsWith('.md') && normalized.indexOf('/', 'verbs/'.length) === -1) {
      return true;
    }
  }
  return false;
}

function isImplicitlyAutonomous(normalized: string): boolean {
  for (const prefix of IMPLICIT_AUTONOMOUS_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  // campaigns/<id>/logs/ — logging inside a campaign is autonomous too.
  if (/^campaigns\/[^/]+\/logs\//.test(normalized)) return true;
  return false;
}

function surfaceMatches(surfacePath: string, target: string): boolean {
  if (surfacePath.endsWith('/')) {
    return target === surfacePath.slice(0, -1) || target.startsWith(surfacePath);
  }
  return target === surfacePath;
}

/** Test seam: hand-pick the constitutional list to assert against. */
export const _internals = {
  CONSTITUTIONAL_PATHS,
  IMPLICIT_AUTONOMOUS_PREFIXES,
};
