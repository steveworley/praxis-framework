import path from 'node:path';

import {
  loadAutonomy,
  type AutonomyMode,
  type AutonomySurface,
  type McpVerdict,
} from '@/lib/autonomy-loader.js';

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
  'lib/business-context.yaml',
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
 *      `append-only`, `inline-enrichment`, and `bounded` are allowed (the
 *      surface is returned so the caller can enforce per-mode rules).
 *      `gated` is refused outright.
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
  if (surface.mode === 'bounded') {
    // The caller (the `adjust_param` tool) enforces the per-mode rules —
    // declared bounds, min/max range check, optional step alignment. The
    // gate just says "this surface is open for bounded parameter tweaks;
    // here's the bounds config".
    return { allowed: true, mode: 'bounded', surface };
  }
  // surface.mode === 'gated' (TS narrowing): refused outright.
  return {
    allowed: false,
    reason: `Refusing to write ${normalized}: surface is gated. File an escalation instead.`,
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

export interface McpAllowed {
  allowed: true;
}

export interface McpRefused {
  allowed: false;
  reason: string;
}

export type McpDecision = McpAllowed | McpRefused;

/**
 * Narrow a verdict to the allow-list form, checking the shape at runtime
 * rather than trusting the declared type. The map comes from a hand-rolled
 * parser and is keyed by a caller-supplied server name, so a value that is
 * an object but carries no `allow` array is possible; treating it as an
 * allow-list would throw on `.includes`, and throwing here takes out
 * `getChatTools` and `/capabilities` (both call this inside a `Promise.all`).
 * A verdict we can't read falls through to default-deny.
 */
function hasAllowList(verdict: McpVerdict | undefined): verdict is { allow: string[] } {
  return (
    typeof verdict === 'object' &&
    verdict !== null &&
    Array.isArray((verdict as { allow?: unknown }).allow)
  );
}

/**
 * Server-level gate: may the role talk to this MCP server at all?
 *
 * An entry carrying an allow-list is usable at server level — the per-tool
 * decision belongs to `isMcpToolAllowed`. Keeping them separate means the
 * health/warning surfaces can still say "connected and permitted" for a
 * server whose surface is only partly open.
 */
export async function isMcpAllowed(
  roleHome: string,
  serverName: string,
): Promise<McpDecision> {
  if (typeof serverName !== 'string' || serverName.length === 0) {
    return { allowed: false, reason: 'MCP server name missing.' };
  }
  const autonomy = await loadAutonomy(roleHome);
  const verdict = autonomy?.mcps?.[serverName];
  if (verdict === 'allow') return { allowed: true };
  if (hasAllowList(verdict)) return { allowed: true };
  if (verdict === 'deny') {
    return {
      allowed: false,
      reason:
        `MCP server '${serverName}' is denied in lib/autonomy.yaml. ` +
        `Flip the entry under \`mcps:\` to \`allow\` to enable it.`,
    };
  }
  return {
    allowed: false,
    reason:
      `MCP server '${serverName}' is not declared in lib/autonomy.yaml. ` +
      `Add \`mcps:\n  ${serverName}: allow\` to enable it. Default is deny.`,
  };
}

/**
 * Tool-level gate: may the role call this specific tool on this server?
 *
 * This is the predicate the catalog and the dispatcher both use. Allowing a
 * server whose surface mixes reads with consequential writes is too coarse
 * a decision — the role does not own that server's tool list, so the gate
 * lives here.
 */
export async function isMcpToolAllowed(
  roleHome: string,
  serverName: string,
  toolName: string,
): Promise<McpDecision> {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { allowed: false, reason: 'MCP tool name missing.' };
  }
  const server = await isMcpAllowed(roleHome, serverName);
  if (!server.allowed) return server;

  const autonomy = await loadAutonomy(roleHome);
  const verdict = autonomy?.mcps?.[serverName];
  if (verdict === 'allow') return { allowed: true };
  if (hasAllowList(verdict)) {
    if (verdict.allow.includes(toolName)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `MCP tool '${serverName}__${toolName}' is not in the allow list for ` +
        `'${serverName}' in lib/autonomy.yaml. Allowed: ${verdict.allow.join(', ')}.`,
    };
  }
  return {
    allowed: false,
    reason:
      `MCP server '${serverName}' is not declared in lib/autonomy.yaml. ` +
      `Default is deny.`,
  };
}

/** Test seam: hand-pick the constitutional list to assert against. */
export const _internals = {
  CONSTITUTIONAL_PATHS,
  IMPLICIT_AUTONOMOUS_PREFIXES,
};
