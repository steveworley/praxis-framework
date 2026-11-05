import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  checkReadPolicy,
  normalizeRequestedPath,
  resolveRealRolePath,
} from './role-file-policy.js';
import type { ToolFailure, ToolResult } from './tools.js';

/**
 * `list_role_files` — read-only, one-level directory listing of the role home.
 *
 * Companion to `read_role_file`: slugs carry a random segment and a truncated
 * title, so the role cannot guess the exact path of an escalation, draft or
 * memory entry. This lists what exists so the role can pick a path to read.
 *
 * Bounded by the same fixed policy as `read_role_file` (`role-file-policy.ts`):
 *
 *   - The requested directory must pass path safety, always-deny and the
 *     allow list, and its realpath must stay inside the role home. Refusals
 *     use the same wording as `read_role_file`.
 *   - The role-home root (`.`, empty or omitted path) may be listed; it shows
 *     only allow-listed entries (`persona.md`, `CLAUDE.md`, the allowed dirs).
 *   - Each entry is checked as `<dir>/<name>` against the policy and through
 *     its realpath. Denied, escaping, aliasing, broken or non-regular entries
 *     are omitted, not reported — the listing never reveals a secret's name.
 *   - `filter` is matched case-insensitively against the entry name. Without
 *     wildcards it is a prefix; with `*` (any run) or `?` (one character) it is
 *     a glob over the whole name. No other characters are special.
 *   - `sort` is `name` (ascending, default) or `mtime` (newest first, ties by
 *     name). Results are capped at {@link LIST_ROLE_FILES_MAX_ENTRIES} after
 *     sorting, with a notice; `total` is the count before the cap.
 */

export const LIST_ROLE_FILES_MAX_ENTRIES = 200;

const TOOL_NAME = 'list_role_files';

export const ListRoleFilesInput = z.object({
  path: z.string().trim().max(512).default('.'),
  filter: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['name', 'mtime']).default('name'),
});

export interface RoleFileEntry {
  name: string;
  type: 'file' | 'dir';
  /** Bytes; files only. */
  size?: number;
  /** ISO 8601 modification time. */
  mtime: string;
}

export async function executeListRoleFiles(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = ListRoleFilesInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`list_role_files input invalid: ${formatZodError(parsed.error)}`);
  }
  const { path: requested, filter, sort } = parsed.data;

  let rel: string | null;
  let dirAbs: string;
  if (isRootPath(requested)) {
    rel = null;
    dirAbs = await fs.realpath(roleHome);
  } else {
    rel = normalizeRequestedPath(requested);
    if (rel === null) {
      return fail(
        `list_role_files: refusing unsafe path: ${requested}. Use a path relative to the role home without '..'.`,
      );
    }
    const policyRefusal = checkReadPolicy(TOOL_NAME, rel);
    if (policyRefusal) return policyRefusal;

    const resolved = await resolveRealRolePath(TOOL_NAME, roleHome, rel);
    if (!resolved.ok) return resolved;
    dirAbs = resolved.realAbs;

    const stat = await fs.stat(dirAbs);
    if (stat.isFile()) {
      return fail(`list_role_files: ${rel} is a file. Use read_role_file to read it.`);
    }
    if (!stat.isDirectory()) {
      return fail(`list_role_files: ${rel} is not a directory.`);
    }
  }

  const matches = filter === undefined ? () => true : nameMatcher(filter);
  const names = (await fs.readdir(dirAbs)).filter(matches);

  const entries: RoleFileEntry[] = [];
  for (const name of names) {
    const entry = await describeEntry(roleHome, rel === null ? name : `${rel}/${name}`, name);
    if (entry) entries.push(entry);
  }
  entries.sort(sort === 'mtime' ? byMtimeDesc : byName);

  const shownPath = rel ?? '.';
  const total = entries.length;
  const truncated = total > LIST_ROLE_FILES_MAX_ENTRIES;
  const data: Record<string, unknown> = {
    path: shownPath,
    entries: entries.slice(0, LIST_ROLE_FILES_MAX_ENTRIES),
    total,
    truncated,
  };
  if (truncated) {
    data['notice'] =
      `Truncated: returned the first ${LIST_ROLE_FILES_MAX_ENTRIES} of ${total} entries ` +
      `(sorted by ${sort}). Narrow the listing with a filter, or sort by mtime for the newest.`;
    return {
      ok: true,
      summary: `listed ${shownPath} (truncated: ${LIST_ROLE_FILES_MAX_ENTRIES} of ${total} entries)`,
      data,
    };
  }
  return { ok: true, summary: `listed ${shownPath} (${total} entries)`, data };
}

/** `.`, `./`, empty — any spelling of the role home itself. */
function isRootPath(requested: string): boolean {
  if (requested.startsWith('/') || path.isAbsolute(requested)) return false;
  return requested
    .replace(/\\/g, '/')
    .split('/')
    .every((s) => s === '' || s === '.');
}

/**
 * Return the entry for `rel`, or null when policy, containment or file shape
 * says it must be omitted.
 */
async function describeEntry(
  roleHome: string,
  rel: string,
  name: string,
): Promise<RoleFileEntry | null> {
  if (checkReadPolicy(TOOL_NAME, rel)) return null;
  const resolved = await resolveRealRolePath(TOOL_NAME, roleHome, rel);
  if (!resolved.ok) return null;

  const stat = await fs.stat(resolved.realAbs);
  const mtime = stat.mtime.toISOString();
  if (stat.isFile()) return { name, type: 'file', size: stat.size, mtime };
  if (stat.isDirectory()) return { name, type: 'dir', mtime };
  return null;
}

function nameMatcher(filter: string): (name: string) => boolean {
  if (!/[*?]/.test(filter)) {
    const prefix = filter.toLowerCase();
    return (name) => name.toLowerCase().startsWith(prefix);
  }
  const source = filter
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${source}$`, 'is');
  return (name) => re.test(name);
}

function byName(a: RoleFileEntry, b: RoleFileEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byMtimeDesc(a: RoleFileEntry, b: RoleFileEntry): number {
  return b.mtime.localeCompare(a.mtime) || byName(a, b);
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
