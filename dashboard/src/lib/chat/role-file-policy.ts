import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveInsideRoleHome } from '../role-home.js';
import type { ToolFailure } from './tools.js';

/**
 * Read policy shared by the read-only role-home tools (`read_role_file`,
 * `list_role_files`). Fixed and independent of autonomy.yaml, which decides
 * writes only:
 *
 *   1. Path safety — {@link normalizeRequestedPath} rejects absolute paths,
 *      `..` segments and null bytes.
 *   2. Always-deny — secrets live in the role home (it is mounted into the
 *      container), so `.env` / `.env.*`, anything under `.tokens/`, `.git/`
 *      or `state/`, and key/credential-shaped names are refused.
 *   3. Allow list — `persona.md`, `CLAUDE.md`, and paths under `lib/`,
 *      `verbs/`, `memory/`, `output/`, `escalations/`, `logs/`.
 *   4. Symlinks — {@link resolveRealRolePath} requires the realpath to stay
 *      inside the role home and re-checks the resolved path against rules 2
 *      and 3, so an allowed name cannot alias a denied file.
 */

export const ALLOWED_ROLE_FILES: readonly string[] = ['persona.md', 'CLAUDE.md'];

export const ALLOWED_ROLE_DIRS: readonly string[] = [
  'lib',
  'verbs',
  'memory',
  'output',
  'escalations',
  'logs',
];

/** Directory names denied at any depth. */
const DENIED_DIRS: ReadonlySet<string> = new Set(['.git', '.tokens', 'state']);

/**
 * Secret-shaped names, matched case-insensitively against every path segment
 * so a `credentials/` directory is covered as well as a `credentials.json`.
 */
const DENIED_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /credentials/i,
  /-sa-key\.json$/i,
  /^id_/i,
];

const NULL_BYTE = String.fromCharCode(0);

/**
 * Normalise a model-supplied path to a posix, role-relative form. Returns null
 * for anything unsafe: absolute paths, `..` segments, null bytes, or a path
 * that normalises to the role home itself.
 */
export function normalizeRequestedPath(requested: string): string | null {
  if (requested.includes(NULL_BYTE)) return null;
  const posix = requested.replace(/\\/g, '/');
  if (path.isAbsolute(requested) || posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    return null;
  }
  const segments = posix.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/**
 * Apply the always-deny rules, then the allow list, to a normalised path.
 * `toolName` prefixes the refusal so the model knows which call failed.
 */
export function checkReadPolicy(toolName: string, rel: string): ToolFailure | null {
  const segments = rel.split('/');
  const secretLike = segments.some(
    (s) => DENIED_DIRS.has(s) || DENIED_NAME_PATTERNS.some((re) => re.test(s)),
  );
  if (secretLike) {
    return fail(
      `${toolName}: refusing ${rel}: secrets and credential files are never readable from chat.`,
    );
  }

  const [first] = segments;
  const allowed =
    (segments.length === 1 && ALLOWED_ROLE_FILES.includes(rel)) ||
    (first !== undefined && ALLOWED_ROLE_DIRS.includes(first));
  if (!allowed) {
    return fail(
      `${toolName}: refusing ${rel}: not on the read allow list ` +
        `(${[...ALLOWED_ROLE_FILES, ...ALLOWED_ROLE_DIRS.map((d) => `${d}/`)].join(', ')}).`,
    );
  }
  return null;
}

export interface ResolvedRolePath {
  ok: true;
  /** Absolute realpath of the target. */
  realAbs: string;
}

/**
 * Resolve `rel` (already normalised and policy-checked) to its realpath,
 * refusing a target that is missing, resolves outside the role home, or
 * aliases a path the policy denies.
 */
export async function resolveRealRolePath(
  toolName: string,
  roleHome: string,
  rel: string,
): Promise<ResolvedRolePath | ToolFailure> {
  let abs: string;
  try {
    abs = resolveInsideRoleHome(roleHome, rel);
  } catch {
    return fail(`${toolName}: refusing unsafe path: ${rel}.`);
  }

  let realAbs: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(roleHome);
    realAbs = await fs.realpath(abs);
  } catch {
    return fail(`${toolName}: ${rel} not found.`);
  }

  const realRel = path.relative(realRoot, realAbs);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return fail(`${toolName}: refusing ${rel}: it resolves outside the role home.`);
  }
  const realRelPosix = realRel.split(path.sep).join('/');
  if (realRelPosix !== rel) {
    const aliasRefusal = checkReadPolicy(toolName, realRelPosix);
    if (aliasRefusal) return aliasRefusal;
  }
  return { ok: true, realAbs };
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}
