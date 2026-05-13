import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { commitChange } from '../audit.js';
import { isWriteAllowed } from './autonomy-gate.js';
import { localDateString } from './time-helpers.js';
import { slugify } from './tools.js';

/**
 * `consolidate_memory` — fold several overlapping memory entries into a single
 * canonical one. The new entry lands at `memory/<new-slug>.md` (top level —
 * sources may span categories, so flattening keeps the canonical home
 * unambiguous). Each source entry is moved under `memory/archived/<original-
 * subpath>`, carrying an appended `## Consolidated` block that back-references
 * the new entry.
 *
 * Refusal cases (each returns a clear `error` message the model can act on):
 *   - Fewer than 2 source slugs
 *   - Any source slug shape invalid (must be lowercase letters/digits/hyphens)
 *   - A source slug resolves to no live entry under `memory/**`
 *   - A source slug already lives under `memory/archived/`
 *   - A source slug is ambiguous (matches multiple live files)
 *   - `new_title` slugifies to an empty string
 *   - Derived new-slug collides with any existing entry (live or archived)
 *   - Source paths would collide on archive (e.g. two sources at the same
 *     relative subpath — vanishingly unlikely once de-duped, but the existence
 *     check keeps the contract honest)
 *
 * Side effects on success:
 *   - `memory/<new-slug>.md` is written with frontmatter + H1 + new body.
 *   - Each source file is rewritten with an appended `## Consolidated` block
 *     and moved to `memory/archived/<original-subpath>` (subdirs preserved).
 *   - A single audit commit lands with subject
 *     `role(memory): consolidate <N> entries into <new-slug>` and a body
 *     listing each source → archive mapping.
 */

const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const NEW_SLUG_MAX = 80;

export const ConsolidateMemoryInput = z.object({
  source_slugs: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .regex(SLUG_RE, 'slug must be lowercase letters/digits/hyphens, starting with a letter'),
    )
    .min(2, 'consolidate needs at least 2 sources'),
  new_title: z.string().trim().min(1).max(160),
  new_body: z.string().min(1),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type ConsolidateMemoryArgs = z.infer<typeof ConsolidateMemoryInput>;

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

interface ResolvedSource {
  slug: string;
  /** Path relative to roleHome, e.g. `memory/people/alice.md`. */
  sourceRel: string;
  /** Path relative to roleHome, e.g. `memory/archived/people/alice.md`. */
  targetRel: string;
}

export async function executeConsolidateMemory(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = ConsolidateMemoryInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`consolidate_memory input invalid: ${formatZodError(parsed.error)}`);
  }
  const { source_slugs, new_title, new_body, reason } = parsed.data;

  // De-dupe source slugs while preserving order. Repeated slugs in the same
  // call would otherwise try to archive the same file twice.
  const uniqueSlugs: string[] = [];
  const seen = new Set<string>();
  for (const s of source_slugs) {
    if (!seen.has(s)) {
      seen.add(s);
      uniqueSlugs.push(s);
    }
  }
  if (uniqueSlugs.length < 2) {
    return fail('consolidate_memory: need at least 2 distinct source slugs.');
  }

  // Derive the new slug from the title using the shared slugify helper, then
  // cap at NEW_SLUG_MAX chars (trim trailing hyphen if the cap landed on one).
  const newSlugRaw = slugify(new_title);
  if (newSlugRaw.length === 0) {
    return fail('consolidate_memory: new_title slugified to an empty string.');
  }
  const newSlug = newSlugRaw.slice(0, NEW_SLUG_MAX).replace(/-+$/, '');
  if (newSlug.length === 0) {
    return fail('consolidate_memory: derived new-slug is empty after length cap.');
  }

  // Resolve each source slug to its live path. Reject on any miss / ambiguity
  // before doing any disk work.
  const resolved: ResolvedSource[] = [];
  for (const slug of uniqueSlugs) {
    const matches = await findMemoryFilesBySlug(roleHome, slug);
    const liveMatches = matches.filter((rel) => !rel.startsWith('memory/archived/'));
    if (liveMatches.length === 0) {
      if (matches.length > 0) {
        return fail(
          `consolidate_memory: '${slug}' is already archived under ${matches[0]}.`,
        );
      }
      return fail(
        `consolidate_memory: no memory entry found with slug '${slug}'. The slug is the filename stem under memory/.`,
      );
    }
    if (liveMatches.length > 1) {
      return fail(
        `consolidate_memory: slug '${slug}' is ambiguous — found in multiple categories (${liveMatches.join(
          ', ',
        )}). File a help escalation to disambiguate.`,
      );
    }
    const sourceRel = liveMatches[0];
    if (!sourceRel) {
      // Defensive: liveMatches.length === 1 guards this.
      return fail(`consolidate_memory: could not resolve source path for '${slug}'.`);
    }
    const relSubpath = sourceRel.slice('memory/'.length);
    const targetRel = `memory/archived/${relSubpath}`;
    resolved.push({ slug, sourceRel, targetRel });
  }

  // Check archive-target collisions: an archive target must not already
  // exist on disk, and two sources must not collide with each other.
  const archiveTargets = new Set<string>();
  for (const r of resolved) {
    if (archiveTargets.has(r.targetRel)) {
      return fail(
        `consolidate_memory: source slugs would collide on archive at ${r.targetRel}.`,
      );
    }
    archiveTargets.add(r.targetRel);
    const targetAbs = path.join(roleHome, r.targetRel);
    if (await fileExists(targetAbs)) {
      return fail(
        `consolidate_memory: ${r.targetRel} already exists. Resolve the collision with your operator before retrying.`,
      );
    }
  }

  // New-slug collision check: refuse if any live or archived entry already
  // uses this slug. Walk memory/**/<new-slug>.md.
  const newSlugMatches = await findMemoryFilesBySlug(roleHome, newSlug);
  if (newSlugMatches.length > 0) {
    const where = newSlugMatches[0];
    return fail(
      `consolidate_memory: new-slug '${newSlug}' collides with existing entry at ${where}. Pick a different title.`,
    );
  }

  const newRel = `memory/${newSlug}.md`;
  // Belt-and-braces: explicit existence check on the canonical write path
  // catches any race where the slug walk above missed the file (e.g. case-
  // insensitive filesystem matching the new path against an unrelated one).
  const newAbs = path.join(roleHome, newRel);
  if (await fileExists(newAbs)) {
    return fail(
      `consolidate_memory: ${newRel} already exists. Pick a different title.`,
    );
  }

  // Autonomy-gate every path we're about to touch. memory/ is implicitly
  // autonomous, so these checks are belt-and-braces against future autonomy
  // changes that might gate the surface.
  const newGate = await isWriteAllowed(roleHome, newRel);
  if (!newGate.allowed) return fail(newGate.reason);
  for (const r of resolved) {
    const sourceGate = await isWriteAllowed(roleHome, r.sourceRel);
    if (!sourceGate.allowed) return fail(sourceGate.reason);
    const targetGate = await isWriteAllowed(roleHome, r.targetRel);
    if (!targetGate.allowed) return fail(targetGate.reason);
  }

  // Read source bodies into memory first. If any read fails, bail before we
  // start mutating the disk — we've not written anything yet.
  const sourceTexts = new Map<string, string>();
  for (const r of resolved) {
    try {
      const text = await fs.readFile(path.join(roleHome, r.sourceRel), 'utf-8');
      sourceTexts.set(r.sourceRel, text);
    } catch (error: unknown) {
      return fail(
        `consolidate_memory: could not read ${r.sourceRel}: ${errorMessage(error)}`,
      );
    }
  }

  // From here we start writing. Roll back on any error.
  const consolidatedAt = now.toISOString();
  const today = localDateString(now);
  const newContent = renderNewEntry(new_title, today, new_body);

  const written: string[] = [];

  try {
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.writeFile(newAbs, newContent, 'utf-8');
    written.push(newRel);

    for (const r of resolved) {
      const originalText = sourceTexts.get(r.sourceRel) ?? '';
      const rewritten = appendConsolidatedBlock(originalText, {
        consolidatedAt,
        newSlug,
        reason,
      });
      const targetAbs = path.join(roleHome, r.targetRel);
      await fs.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.writeFile(targetAbs, rewritten, 'utf-8');
      written.push(r.targetRel);
      await fs.unlink(path.join(roleHome, r.sourceRel));
    }
  } catch (error: unknown) {
    // Best-effort rollback of anything we wrote so the operator isn't left
    // with a half-applied consolidation.
    for (const rel of written) {
      await fs.unlink(path.join(roleHome, rel)).catch(() => {});
    }
    return fail(`consolidate_memory: write failed: ${errorMessage(error)}`);
  }

  // Single audit commit covers: the new entry + the (delete, create) pair for
  // each source. `commitChange` already `git add -A`'s the named paths, so a
  // rename surfaces correctly.
  const filePaths: string[] = [newRel];
  for (const r of resolved) {
    filePaths.push(r.sourceRel, r.targetRel);
  }

  const commitBodyLines: string[] = [];
  for (const r of resolved) {
    commitBodyLines.push(`- ${r.slug} → ${r.targetRel.replace(/^memory\//, '')}`);
  }
  if (reason) {
    commitBodyLines.push('', `Reason: ${reason}`);
  }

  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths,
    scope: 'memory',
    subject: `consolidate ${resolved.length} entries into ${newSlug}`,
    body: commitBodyLines.join('\n'),
  });

  const archived = resolved.map((r) => r.targetRel);
  const data: Record<string, unknown> = {
    new_slug: newSlug,
    new_path: newRel,
    archived,
    consolidated_at: consolidatedAt,
  };
  let summary = `consolidated ${resolved.length} entries into ${newRel}`;
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

interface ConsolidatedBlockOpts {
  consolidatedAt: string;
  newSlug: string;
  reason: string | undefined;
}

/**
 * Append a `## Consolidated` block to a source entry's body. The block carries
 * the consolidation timestamp, a back-reference to the new entry's slug, and
 * an optional reason.
 */
function appendConsolidatedBlock(original: string, opts: ConsolidatedBlockOpts): string {
  const lines: string[] = [
    '',
    '## Consolidated',
    '',
    `consolidated_at: ${opts.consolidatedAt}`,
    `consolidated_into: ${opts.newSlug}`,
  ];
  if (opts.reason) {
    lines.push('', opts.reason);
  }
  const trimmed = original.replace(/\s+$/, '');
  return `${trimmed}\n${lines.join('\n')}\n`;
}

function renderNewEntry(title: string, today: string, body: string): string {
  // Mirror write_memory's frontmatter shape so consolidated entries look like
  // any other top-level memory entry to downstream readers.
  const fm = [
    '---',
    `title: ${quoteIfNeeded(title)}`,
    `created: ${today}`,
    `updated: ${today}`,
    '---',
  ].join('\n');
  return `${fm}\n\n# ${title}\n\n${body.trimEnd()}\n`;
}

function quoteIfNeeded(value: string): string {
  if (/^[\s'"#&*!|>%@`\-?,[\]{}]/.test(value) || /[:#]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
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
