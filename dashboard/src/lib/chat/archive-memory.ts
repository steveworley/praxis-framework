import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { commitChange } from '../audit.js';
import { isWriteAllowed } from './autonomy-gate.js';

/**
 * `archive_memory` — retire an existing memory entry by moving it under
 * `memory/archived/<same-path>` and appending an `## Archived` block to the
 * body. The notebook UI walks `memory/archived/` separately and dims
 * archived entries; the operator can `git mv` the file back out for v1's
 * un-archive flow.
 *
 * Refusal cases (each returns a clear `error` message the model can act on):
 *   - Slug shape invalid (must be lowercase letters/digits/hyphens)
 *   - No entry under `memory/**` matches the slug
 *   - Multiple entries match (operator must disambiguate)
 *   - Entry is already under `memory/archived/` (no double-archive)
 *   - Target archived path already exists (operator pre-empted us; refuse)
 *
 * Side effects on success:
 *   - The original file is removed and the rewritten content (with the
 *     appended `## Archived` block) is written to the archived path.
 *   - A single audit commit lands with subject `role(memory): archive <slug>`
 *     and an optional body containing the reason.
 */

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export const ArchiveMemoryInput = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(SLUG_RE, 'slug must be lowercase letters/digits/hyphens, starting with a letter'),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ArchiveMemoryArgs = z.infer<typeof ArchiveMemoryInput>;

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

export async function executeArchiveMemory(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = ArchiveMemoryInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`archive_memory input invalid: ${formatZodError(parsed.error)}`);
  }
  const { slug, reason } = parsed.data;

  const matches = await findMemoryFilesBySlug(roleHome, slug);
  const liveMatches = matches.filter((rel) => !rel.startsWith('memory/archived/'));

  if (liveMatches.length === 0) {
    if (matches.length > 0) {
      return fail(
        `archive_memory: '${slug}' is already archived under ${matches[0]}.`,
      );
    }
    return fail(
      `archive_memory: no memory entry found with slug '${slug}'. The slug is the filename stem under memory/.`,
    );
  }
  if (liveMatches.length > 1) {
    return fail(
      `archive_memory: slug '${slug}' is ambiguous — found in multiple categories (${liveMatches.join(
        ', ',
      )}). File a help escalation to disambiguate.`,
    );
  }

  const sourceRel = liveMatches[0];
  if (!sourceRel) {
    // Defensive — `liveMatches.length === 1` guards this, but the explicit
    // check keeps the narrower types honest for downstream consumers.
    return fail(`archive_memory: could not resolve source path for '${slug}'.`);
  }
  // `memory/<...>/foo.md` → `memory/archived/<...>/foo.md`. Preserve the
  // subpath beneath `memory/` so categories survive the move.
  const relSubpath = sourceRel.slice('memory/'.length);
  const targetRel = `memory/archived/${relSubpath}`;

  // Autonomy gate guards both sides of the rename — both paths live under
  // `memory/`, which is implicitly autonomous, so this is belt-and-braces.
  const sourceGate = await isWriteAllowed(roleHome, sourceRel);
  if (!sourceGate.allowed) return fail(sourceGate.reason);
  const targetGate = await isWriteAllowed(roleHome, targetRel);
  if (!targetGate.allowed) return fail(targetGate.reason);

  const sourceAbs = path.join(roleHome, sourceRel);
  const targetAbs = path.join(roleHome, targetRel);

  if (await fileExists(targetAbs)) {
    return fail(
      `archive_memory: ${targetRel} already exists. Resolve the collision with your operator before retrying.`,
    );
  }

  let originalText: string;
  try {
    originalText = await fs.readFile(sourceAbs, 'utf-8');
  } catch (error: unknown) {
    return fail(`archive_memory: could not read ${sourceRel}: ${errorMessage(error)}`);
  }

  const archivedAt = now.toISOString();
  const newText = appendArchivedBlock(originalText, archivedAt, reason);

  // Write the rewritten file under the archived path first, then unlink the
  // original. Both paths are inside the same git-tracked tree, so the audit
  // commit captures the move as a delete-and-create pair (which `git add -A`
  // already handles per the audit module's contract).
  try {
    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.writeFile(targetAbs, newText, 'utf-8');
  } catch (error: unknown) {
    return fail(`archive_memory: could not write ${targetRel}: ${errorMessage(error)}`);
  }
  try {
    await fs.unlink(sourceAbs);
  } catch (error: unknown) {
    // Roll back the target write so the role doesn't end up with two copies.
    await fs.unlink(targetAbs).catch(() => {});
    return fail(`archive_memory: could not remove ${sourceRel}: ${errorMessage(error)}`);
  }

  const commitBody = reason ? `Reason: ${reason}` : undefined;
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [sourceRel, targetRel],
    scope: 'memory',
    subject: `archive ${slug}`,
    ...(commitBody ? { body: commitBody } : {}),
  });

  const data: Record<string, unknown> = {
    source_path: sourceRel,
    archived_path: targetRel,
    archived_at: archivedAt,
  };
  let summary = `archived ${sourceRel}`;
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
 * Append an `## Archived` block to the entry body. The block carries the
 * archived timestamp (ISO 8601) and an optional reason — both visible in the
 * dashboard's rendered prose when the operator chooses to reveal archived
 * entries.
 */
function appendArchivedBlock(
  original: string,
  archivedAtIso: string,
  reason: string | undefined,
): string {
  const lines: string[] = ['', '## Archived', '', `archived_at: ${archivedAtIso}`];
  if (reason) {
    lines.push('', reason);
  }
  // Ensure we land on a single trailing newline regardless of the source
  // file's trailing-whitespace shape.
  const trimmed = original.replace(/\s+$/, '');
  return `${trimmed}\n${lines.join('\n')}\n`;
}

async function findMemoryFilesBySlug(roleHome: string, slug: string): Promise<string[]> {
  const memoryRoot = path.join(roleHome, 'memory');
  const matches: string[] = [];
  const stack: string[] = [memoryRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === `${slug}.md`) {
        const rel = path.relative(roleHome, full).split(path.sep).join('/');
        matches.push(rel);
      }
    }
  }
  return matches;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
