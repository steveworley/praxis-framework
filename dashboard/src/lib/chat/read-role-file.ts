import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { resolveInsideRoleHome } from '../role-home.js';
import type { ToolFailure, ToolResult } from './tools.js';

/**
 * `read_role_file` — read-only access to the role home's reference files.
 *
 * The system prompt carries persona, autonomy, business context and the verb
 * list, but not the rest of `lib/*`. A role that is governed by
 * `lib/compliance.yaml` (constitutional: unwritable via tools) still has to
 * read it to obey it, so reads are deliberately NOT routed through the
 * autonomy gate — `isWriteAllowed` decides writes only.
 *
 * Reads are instead bounded by a fixed policy, independent of autonomy.yaml:
 *
 *   1. Path safety — reject absolute paths, `..` segments and null bytes, then
 *      a lexical containment check via `resolveInsideRoleHome`.
 *   2. Always-deny — secrets live in the role home (it is mounted into the
 *      container), so `.env` / `.env.*`, anything under `.tokens/`, `.git/`
 *      or `state/`, and key/credential-shaped names are refused.
 *   3. Allow list — `persona.md`, `CLAUDE.md`, and files under `lib/`,
 *      `verbs/`, `memory/`, `output/`, `escalations/`, `logs/`. Everything
 *      else is refused.
 *   4. Symlinks — the realpath must stay inside the role home, and the
 *      resolved path is re-checked against rules 2 and 3 so an allowed name
 *      cannot alias a denied file.
 *   5. Shape — directories, non-regular files and binary content are refused;
 *      text is capped at {@link READ_ROLE_FILE_MAX_BYTES} with a notice.
 */

export const READ_ROLE_FILE_MAX_BYTES = 64 * 1024;

export const ReadRoleFileInput = z.object({
  path: z.string().trim().min(1).max(512),
});

const ALLOWED_FILES: readonly string[] = ['persona.md', 'CLAUDE.md'];

const ALLOWED_DIRS: readonly string[] = [
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

/** Bytes sniffed for a NUL when classifying a file as binary (git uses 8000). */
const BINARY_SNIFF_BYTES = 8000;

const NULL_BYTE = String.fromCharCode(0);

export async function executeReadRoleFile(
  roleHome: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const parsed = ReadRoleFileInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`read_role_file input invalid: ${formatZodError(parsed.error)}`);
  }
  const requested = parsed.data.path;

  const rel = normalizeRequestedPath(requested);
  if (rel === null) {
    return fail(
      `read_role_file: refusing unsafe path: ${requested}. Use a path relative to the role home without '..'.`,
    );
  }

  const policyRefusal = checkReadPolicy(rel);
  if (policyRefusal) return policyRefusal;

  let abs: string;
  try {
    abs = resolveInsideRoleHome(roleHome, rel);
  } catch {
    return fail(`read_role_file: refusing unsafe path: ${requested}.`);
  }

  let realAbs: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(roleHome);
    realAbs = await fs.realpath(abs);
  } catch {
    return fail(`read_role_file: ${rel} not found.`);
  }

  const realRel = path.relative(realRoot, realAbs);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return fail(`read_role_file: refusing ${rel}: it resolves outside the role home.`);
  }
  const realRelPosix = realRel.split(path.sep).join('/');
  if (realRelPosix !== rel) {
    const aliasRefusal = checkReadPolicy(realRelPosix);
    if (aliasRefusal) return aliasRefusal;
  }

  const stat = await fs.stat(realAbs);
  if (stat.isDirectory()) {
    return fail(`read_role_file: ${rel} is a directory. Pass a file path.`);
  }
  if (!stat.isFile()) {
    return fail(`read_role_file: ${rel} is not a regular file.`);
  }

  const total = stat.size;
  const truncated = total > READ_ROLE_FILE_MAX_BYTES;
  const buf = await readHead(realAbs, Math.min(total, READ_ROLE_FILE_MAX_BYTES));

  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return fail(`read_role_file: ${rel} looks like a binary file; only text files can be read.`);
  }

  const content = decodeUtf8(buf, truncated);
  if (content === null) {
    return fail(`read_role_file: ${rel} is not valid UTF-8 text; only text files can be read.`);
  }

  const returned = Buffer.byteLength(content);
  const data: Record<string, unknown> = {
    path: rel,
    content,
    bytes: total,
    returned_bytes: returned,
    truncated,
  };
  if (truncated) {
    data['notice'] =
      `Truncated: returned the first ${returned} of ${total} bytes ` +
      `(cap ${READ_ROLE_FILE_MAX_BYTES}). The rest of the file was not read.`;
    return { ok: true, summary: `read ${rel} (truncated: ${returned} of ${total} bytes)`, data };
  }
  return { ok: true, summary: `read ${rel} (${total} bytes)`, data };
}

/**
 * Normalise a model-supplied path to a posix, role-relative form. Returns null
 * for anything unsafe: absolute paths, `..` segments, null bytes, or a path
 * that normalises to the role home itself.
 */
function normalizeRequestedPath(requested: string): string | null {
  if (requested.includes(NULL_BYTE)) return null;
  const posix = requested.replace(/\\/g, '/');
  if (path.isAbsolute(requested) || posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
    return null;
  }
  const segments = posix.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** Apply the always-deny rules, then the allow list, to a normalised path. */
function checkReadPolicy(rel: string): ToolFailure | null {
  const segments = rel.split('/');
  const secretLike = segments.some(
    (s) => DENIED_DIRS.has(s) || DENIED_NAME_PATTERNS.some((re) => re.test(s)),
  );
  if (secretLike) {
    return fail(
      `read_role_file: refusing ${rel}: secrets and credential files are never readable from chat.`,
    );
  }

  const [first] = segments;
  const allowed =
    (segments.length === 1 && ALLOWED_FILES.includes(rel)) ||
    (first !== undefined && ALLOWED_DIRS.includes(first));
  if (!allowed) {
    return fail(
      `read_role_file: refusing ${rel}: not on the read allow list ` +
        `(${[...ALLOWED_FILES, ...ALLOWED_DIRS.map((d) => `${d}/`)].join(', ')}).`,
    );
  }
  return null;
}

async function readHead(abs: string, length: number): Promise<Buffer> {
  const handle = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Strict UTF-8 decode. When the buffer was cut at the byte cap, streaming mode
 * holds back an incomplete trailing sequence instead of treating it as
 * invalid, so truncation never splits a character.
 */
function decodeUtf8(buf: Buffer, truncated: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: truncated });
  } catch {
    return null;
  }
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
