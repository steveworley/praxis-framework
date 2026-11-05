import fs from 'node:fs/promises';

import { z } from 'zod';

import {
  checkReadPolicy,
  normalizeRequestedPath,
  resolveRealRolePath,
} from './role-file-policy.js';
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
 * Reads are instead bounded by the fixed policy in `role-file-policy.ts`
 * (path safety, always-deny secrets, allow list, symlink containment), shared
 * with `list_role_files`. On top of that:
 *
 *   - Shape — directories, non-regular files and binary content are refused;
 *      text is capped at {@link READ_ROLE_FILE_MAX_BYTES} with a notice.
 */

export const READ_ROLE_FILE_MAX_BYTES = 64 * 1024;

const TOOL_NAME = 'read_role_file';

export const ReadRoleFileInput = z.object({
  path: z.string().trim().min(1).max(512),
});

/** Bytes sniffed for a NUL when classifying a file as binary (git uses 8000). */
const BINARY_SNIFF_BYTES = 8000;

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

  const policyRefusal = checkReadPolicy(TOOL_NAME, rel);
  if (policyRefusal) return policyRefusal;

  const resolved = await resolveRealRolePath(TOOL_NAME, roleHome, rel);
  if (!resolved.ok) return resolved;
  const { realAbs } = resolved;

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
