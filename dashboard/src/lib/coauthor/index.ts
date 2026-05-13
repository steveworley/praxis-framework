import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createPatch } from 'diff';

import { commitChange } from '@/lib/audit.js';
import { sendMessage } from '@/lib/chat/anthropic.js';
import { loadEscalation } from '@/lib/triage.js';

import { buildCoauthorPrompt, extractFileContent } from './prompt.js';
import {
  CoauthorNotFoundError,
  CoauthorValidationError,
  type ApplyRequest,
  type ApplyResponse,
  type ConstitutionalTarget,
  type DraftRequest,
  type DraftResponse,
} from './types.js';

export * from './types.js';

const VERB_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const LIB_FILENAME_RE = /^[A-Za-z0-9._-]+\.(?:ya?ml|md|json|toml)$/;

/**
 * Resolve a ConstitutionalTarget to its relative path inside the role home.
 * Pure function (no IO). Throws CoauthorValidationError for malformed inputs.
 */
export function resolveTargetPath(target: ConstitutionalTarget): string {
  switch (target.kind) {
    case 'persona':
      return 'persona.md';
    case 'claude-md':
      return 'CLAUDE.md';
    case 'verb': {
      if (!VERB_SLUG_RE.test(target.slug)) {
        throw new CoauthorValidationError(
          `Invalid verb slug: '${target.slug}'. Must match ${VERB_SLUG_RE}.`,
        );
      }
      return path.posix.join('verbs', `${target.slug}.md`);
    }
    case 'lib': {
      const name = target.filename;
      if (!LIB_FILENAME_RE.test(name) || name.includes('/') || name.includes('\\')) {
        throw new CoauthorValidationError(
          `Invalid lib filename: '${name}'. Must be a single basename matching ${LIB_FILENAME_RE}.`,
        );
      }
      return path.posix.join('lib', name);
    }
  }
}

/**
 * Resolve `relativePath` to an absolute path inside `roleHome`, refusing
 * anything that escapes the boundary. Mirrors `resolveInsideRoleHome` from
 * `role-home.ts` but throws our typed error so the API surface can map it to
 * a 400.
 */
function resolveInside(roleHome: string, relativePath: string): string {
  const absRoot = path.resolve(roleHome);
  const absTarget = path.resolve(absRoot, relativePath);
  const rel = path.relative(absRoot, absTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CoauthorValidationError(`Refusing path outside role home: ${relativePath}`);
  }
  return absTarget;
}

/**
 * Allowlist a relative target_path string against the same set of surfaces
 * resolveTargetPath produces. Prevents the apply call from being directed at
 * arbitrary files even if the path traversal check passes.
 */
function assertAllowlistedTargetPath(relativePath: string): void {
  if (relativePath === 'persona.md') return;
  if (relativePath === 'CLAUDE.md') return;
  if (relativePath.startsWith('verbs/')) {
    const slug = path.posix.basename(relativePath, '.md');
    if (relativePath === `verbs/${slug}.md` && VERB_SLUG_RE.test(slug)) return;
  }
  if (relativePath.startsWith('lib/')) {
    const name = path.posix.basename(relativePath);
    if (relativePath === `lib/${name}` && LIB_FILENAME_RE.test(name)) return;
  }
  throw new CoauthorValidationError(
    `Target path is not on the co-authoring allowlist: ${relativePath}`,
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/;

function hasFrontmatter(text: string): boolean {
  return FRONTMATTER_RE.test(text);
}

/**
 * Draft a constitutional change. Reads the escalation + the current file
 * content, builds a prompt, calls the model, then computes a unified diff
 * between current and proposed content.
 *
 * Refuses if the escalation does not exist or the target file is missing for
 * surfaces where missing makes no sense (persona, CLAUDE.md, an existing
 * verb). For `lib/<filename>` we tolerate a missing file — operators can
 * co-author a brand-new lib file when the escalation calls for one.
 */
export async function draftChange(roleHome: string, req: DraftRequest): Promise<DraftResponse> {
  if (req.directive.trim().length === 0) {
    throw new CoauthorValidationError('Directive is required.');
  }

  // Anchor the draft to a real escalation. We don't enforce status === 'accepted'
  // here (the operator may want to draft against a still-open escalation as
  // part of accepting it); the *audit trail* is what matters, not the lifecycle.
  const escalation = await loadEscalation(roleHome, req.escalation_id);

  const targetPath = resolveTargetPath(req.target);
  const abs = resolveInside(roleHome, targetPath);

  let currentContent = '';
  if (await fileExists(abs)) {
    currentContent = await fs.readFile(abs, 'utf-8');
  } else if (req.target.kind !== 'lib') {
    throw new CoauthorNotFoundError(
      `Target file does not exist and cannot be created by co-authoring: ${targetPath}`,
    );
  }

  const { system, user } = buildCoauthorPrompt({
    escalation,
    target_path: targetPath,
    current_content: currentContent,
    directive: req.directive,
  });

  const modelReply = await sendMessage(system, [], user, {
    // Co-authoring is bounded by file size; raise above the chat default so
    // the model can return a full persona/CLAUDE.md rewrite without truncation.
    maxTokens: 4096,
  });

  const proposedContent = extractFileContent(modelReply);
  const diff_unified = createPatch(
    targetPath,
    currentContent,
    proposedContent,
    'current',
    'proposed',
  );

  return {
    target_path: targetPath,
    current_content: currentContent,
    proposed_content: proposedContent,
    diff_unified,
    rationale: '',
  };
}

/**
 * Apply a co-authored change. Validates path + frontmatter preservation, writes
 * atomically, then commits as the operator with a `Co-Authored-By: Praxis Role`
 * trailer so `git log --author=` filtering still shows the operator while
 * `git log --grep='Co-Authored-By: Praxis Role'` finds every co-authored edit.
 */
export async function applyChange(roleHome: string, req: ApplyRequest): Promise<ApplyResponse> {
  assertAllowlistedTargetPath(req.target_path);

  // Re-anchor to the escalation. Same reasoning as draftChange: every apply
  // must reference an existing escalation so the audit story stays intact.
  const escalation = await loadEscalation(roleHome, req.escalation_id);

  const abs = resolveInside(roleHome, req.target_path);
  const proposed = req.proposed_content;
  if (proposed.length === 0) {
    throw new CoauthorValidationError('Proposed content is empty.');
  }

  // Frontmatter guard: if the file currently has a frontmatter block, the new
  // content must too. Models occasionally drop the leading `---` block; that
  // would silently break the file's parsers.
  if (await fileExists(abs)) {
    const current = await fs.readFile(abs, 'utf-8');
    if (hasFrontmatter(current) && !hasFrontmatter(proposed)) {
      throw new CoauthorValidationError(
        `Refusing apply: original file has frontmatter (\`---\` block), proposed content does not. Re-draft or edit before applying.`,
      );
    }
  }

  await atomicWrite(abs, proposed);

  const scope = scopeForTarget(req.target_path);
  const subject = `co-author ${shortSummary(escalation.title)} (#${escalation.id})`;
  const body = [
    `Applied co-authored change to ${req.target_path}.`,
    '',
    `Escalation: ${escalation.id} (${escalation.kind})`,
    `Title: ${escalation.title}`,
    '',
    'Co-Authored-By: Praxis Role <role@praxis.local>',
  ].join('\n');

  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths: [req.target_path],
    scope,
    subject,
    body,
  });

  if (!commit.committed || !commit.sha) {
    // The disk write succeeded but the audit commit didn't land. Surface the
    // warning rather than failing — same posture as the rest of the dashboard.
    const result: ApplyResponse = {
      commit_sha: '',
      commit_short_sha: '',
    };
    if (commit.warning) result.commit_warning = commit.warning;
    return result;
  }

  const result: ApplyResponse = {
    commit_sha: commit.sha,
    commit_short_sha: commit.shortSha ?? commit.sha.slice(0, 7),
  };
  if (commit.warning) result.commit_warning = commit.warning;
  return result;
}

/**
 * Conventional-commit scope picked from the target path. Mirrors the
 * documented scopes in docs/dashboard.md.
 */
function scopeForTarget(relativePath: string): string {
  if (relativePath === 'persona.md') return 'persona';
  if (relativePath === 'CLAUDE.md') return 'claude-md';
  if (relativePath.startsWith('verbs/')) return 'verb';
  if (relativePath.startsWith('lib/')) return 'lib';
  return 'constitution';
}

function shortSummary(title: string): string {
  const cleaned = title.trim().replace(/\s+/g, ' ');
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}
