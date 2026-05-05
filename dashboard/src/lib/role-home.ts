import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLE_HOME_ENV = 'PRAXIS_ROLE_HOME';
const LOG_GLOB_ENV = 'PRAXIS_LOG_GLOB';
const DEFAULT_LOG_GLOB = '*/logs/*.jsonl';

/**
 * Resolves the role home directory. By convention this is the parent of the
 * dashboard directory (the framework repo / role root). Override with the
 * PRAXIS_ROLE_HOME env var.
 */
export function getRoleHome(): string {
  const fromEnv = process.env[ROLE_HOME_ENV];
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv.replace(/^~(?=$|\/)/, process.env['HOME'] ?? ''));
  }
  // Default: parent of this file's package directory.
  // src/lib/role-home.ts -> src/lib -> src -> dashboard -> <role-home>
  const here = fileURLToPath(new URL('.', import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

export function getLogGlob(): string {
  return process.env[LOG_GLOB_ENV] ?? DEFAULT_LOG_GLOB;
}

export type RoleMode = 'seed' | 'role';

/**
 * Detect whether the role home has been seeded. A populated role has
 * agents/persona.md at the root.
 */
export function detectMode(roleHome: string): RoleMode {
  const personaPath = path.join(roleHome, 'agents', 'persona.md');
  return existsSync(personaPath) ? 'role' : 'seed';
}

/**
 * Resolve a path relative to the role home, refusing anything that escapes
 * the boundary via traversal. Returns the absolute path on success, throws
 * on traversal.
 */
export function resolveInsideRoleHome(roleHome: string, relativePath: string): string {
  const absRoot = path.resolve(roleHome);
  const absTarget = path.resolve(absRoot, relativePath);
  const rel = path.relative(absRoot, absTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing path outside role home: ${relativePath}`);
  }
  return absTarget;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
