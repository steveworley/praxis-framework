import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { createPatch } from 'diff';

import { commitChange } from '@/lib/audit.js';
import { sendMessageWithTools, type ToolExecResult } from '@/lib/chat/anthropic.js';
import { loadEscalation } from '@/lib/triage.js';

import { buildCoauthorPrompt, readRoleFilesForContext } from './prompt.js';
import {
  CoauthorValidationError,
  type ApplyRequest,
  type ApplyResponse,
  type FileProposal,
  type FileProposalKind,
  type ProposeRequest,
  type ProposeResponse,
} from './types.js';

export * from './types.js';
export { buildCoauthorPrompt, readRoleFilesForContext } from './prompt.js';

const VERB_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const LIB_FILENAME_RE = /^[A-Za-z0-9._-]+\.(?:ya?ml|md|json|toml)$/;

/**
 * Constitutional lib files the role gates from chat-side tools. The model
 * isn't allowed to propose changes to these surfaces via co-authoring either,
 * even though the operator is the actor at apply time — these files belong to
 * the operator's hand, not the model's.
 */
const GATED_LIB_FILES = new Set([
  'lib/customers.yaml',
  'lib/compliance.yaml',
  'lib/autonomy.yaml',
  'lib/tools.yaml',
]);

/**
 * Cap on tool-call iterations during a single propose call. Most real
 * proposals will be 1–3 files; we cap at 6 to leave headroom for the model to
 * reconsider while logging a warning if it bloats past that. The framework's
 * MAX_TOOL_ITERATIONS on the chat side is 10 — we sit deliberately lower so a
 * runaway tool loop here doesn't burn a long context window.
 */
const MAX_PROPOSAL_ITERATIONS = 8;

/**
 * Soft cap before we log a "this proposal is probably bloated" warning. The
 * model can still keep going up to MAX_PROPOSAL_ITERATIONS; this is just the
 * line where we'd treat the proposal as suspicious in logs.
 */
const PROPOSAL_BLOAT_THRESHOLD = 6;

const TOOL_NAME = 'propose_file_change';

const PROPOSE_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    'Propose a single file change. Call once per file you want to change. ' +
    'Pass the FULL new file content (not a patch) and a one-sentence rationale.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Relative path inside the role home. Must be one of: persona.md, CLAUDE.md, verbs/<slug>.md (live verbs only, NOT verbs/proposed/), or lib/<filename> (non-constitutional lib files).',
      },
      new_content: {
        type: 'string',
        description: 'The complete new file content. Preserve frontmatter where present.',
      },
      rationale: {
        type: 'string',
        description: 'One-sentence "why this change" specific to this file.',
      },
    },
    required: ['path', 'new_content', 'rationale'],
  },
};

interface CollectedProposal {
  path: string;
  current_content: string;
  proposed_content: string;
  rationale: string;
  kind: FileProposalKind;
}

/**
 * Classify a relative path into a FileProposalKind, AND assert that the path
 * is one of the surfaces co-authoring may touch.
 *
 * Refuses constitutional lib files (the gated set in autonomy-gate.ts) — the
 * model isn't allowed to propose those changes even though the operator can
 * edit them by hand. The operator IS the actor at apply time, but routing
 * those edits through the model's hand is the wrong default.
 */
export function classifyAndAssertPath(relativePath: string): FileProposalKind {
  if (relativePath === 'persona.md') return 'persona';
  if (relativePath === 'CLAUDE.md') return 'claude-md';
  if (relativePath.startsWith('verbs/')) {
    if (relativePath.startsWith('verbs/proposed/')) {
      throw new CoauthorValidationError(
        `Refusing proposal against verbs/proposed/: ${relativePath}. Proposed drafts go through the triage queue, not co-authoring.`,
      );
    }
    const slug = path.posix.basename(relativePath, '.md');
    if (relativePath === `verbs/${slug}.md` && VERB_SLUG_RE.test(slug)) return 'verb';
    throw new CoauthorValidationError(
      `Invalid verb path: ${relativePath}. Expected verbs/<slug>.md with kebab-case slug.`,
    );
  }
  if (relativePath.startsWith('lib/')) {
    if (GATED_LIB_FILES.has(relativePath)) {
      throw new CoauthorValidationError(
        `Refusing proposal against constitutional lib file: ${relativePath}. Edit by hand if needed.`,
      );
    }
    const name = path.posix.basename(relativePath);
    if (relativePath === `lib/${name}` && LIB_FILENAME_RE.test(name)) return 'lib';
    throw new CoauthorValidationError(
      `Invalid lib path: ${relativePath}. Expected lib/<filename> with allowed extension.`,
    );
  }
  throw new CoauthorValidationError(
    `Target path is not on the co-authoring allowlist: ${relativePath}`,
  );
}

/**
 * Resolve `relativePath` to an absolute path inside `roleHome`, refusing
 * anything that escapes the boundary. Mirrors the path-safety pattern in
 * `triage.ts` and `chat/tools.ts`.
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
 * Run the model's propose loop. Reads the escalation + role files, sends them
 * with the `propose_file_change` tool, accumulates proposals from each tool
 * call, then returns the proposals + the model's overall summary text.
 *
 * Constraints applied here (refused via `is_error: true` tool result so the
 * model can retry with a different path):
 *   - Path-traversal check
 *   - Allowlist + constitutional-lib refusal
 *   - New content must be non-empty
 *   - For files with existing frontmatter, the new content must keep it
 */
export async function proposeChange(
  roleHome: string,
  req: ProposeRequest,
): Promise<ProposeResponse> {
  // Anchor the propose call to a real escalation. The audit trail rests on
  // every co-authoring session being tied to an operator-visible request.
  const escalation = await loadEscalation(roleHome, req.escalation_id);

  const files = await readRoleFilesForContext(roleHome);
  const { system, user } = buildCoauthorPrompt({
    escalation,
    hint: req.hint,
    files,
  });

  // Build an in-memory map of "what's on disk now" so we can validate
  // proposals + populate current_content without re-reading per tool call.
  const currentContents = new Map<string, string>();
  for (const f of files) {
    currentContents.set(f.path, f.content);
  }

  const proposals: CollectedProposal[] = [];

  const executor = async (name: string, input: unknown): Promise<ToolExecResult> => {
    if (name !== TOOL_NAME) {
      return {
        ok: false,
        contentText: `Unknown tool '${name}'. Only \`${TOOL_NAME}\` is available.`,
      };
    }
    const parsed = parseToolInput(input);
    if (!parsed.ok) {
      return { ok: false, contentText: parsed.error };
    }
    try {
      const kind = classifyAndAssertPath(parsed.path);
      // Path-traversal guard (belt-and-braces — classifyAndAssertPath already
      // refuses the path shapes that could escape, but resolve here so a
      // mistake in the allowlist can't get past the path check).
      resolveInside(roleHome, parsed.path);

      const abs = resolveInside(roleHome, parsed.path);
      let currentContent = currentContents.get(parsed.path) ?? '';
      if (!currentContents.has(parsed.path) && (await fileExists(abs))) {
        currentContent = await fs.readFile(abs, 'utf-8');
        currentContents.set(parsed.path, currentContent);
      }

      if (parsed.new_content.length === 0) {
        return {
          ok: false,
          contentText: `Refusing empty new_content for ${parsed.path}.`,
        };
      }
      if (hasFrontmatter(currentContent) && !hasFrontmatter(parsed.new_content)) {
        return {
          ok: false,
          contentText: `Refusing change to ${parsed.path}: original file has a \`---\` frontmatter block, proposed content does not. Re-issue the tool call with frontmatter preserved.`,
        };
      }

      // Replace any prior proposal for the same path with the latest call.
      const existingIdx = proposals.findIndex((p) => p.path === parsed.path);
      const collected: CollectedProposal = {
        path: parsed.path,
        current_content: currentContent,
        proposed_content: parsed.new_content,
        rationale: parsed.rationale,
        kind,
      };
      if (existingIdx >= 0) {
        proposals[existingIdx] = collected;
      } else {
        proposals.push(collected);
      }
      return { ok: true, contentText: `Proposal recorded for ${parsed.path}.` };
    } catch (e) {
      if (e instanceof CoauthorValidationError) {
        return { ok: false, contentText: e.message };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, contentText: `Internal error recording proposal: ${msg}` };
    }
  };

  const result = await sendMessageWithTools(
    system,
    [],
    user,
    [PROPOSE_TOOL],
    executor,
    {
      // Proposals can return large file contents — raise the cap beyond the
      // chat default so a multi-file rewrite isn't truncated.
      maxTokens: 8192,
    },
  );

  if (proposals.length === 0) {
    throw new CoauthorValidationError(
      'The model did not propose any file changes. Try re-drafting with more specific guidance.',
    );
  }

  if (proposals.length > PROPOSAL_BLOAT_THRESHOLD) {
    // Log to stderr — this is unusual enough that we want it in the dashboard's
    // server logs, but it's not an error the operator needs to see (the
    // proposals are still rendered for review).
    console.warn(
      `[coauthor] propose returned ${proposals.length} file proposals for escalation ${escalation.id} — review for bloat.`,
    );
  }

  const fileProposals: FileProposal[] = proposals.map((p) => ({
    path: p.path,
    current_content: p.current_content,
    proposed_content: p.proposed_content,
    diff_unified: createPatch(p.path, p.current_content, p.proposed_content, 'current', 'proposed'),
    rationale: p.rationale,
    kind: p.kind,
  }));

  const response: ProposeResponse = {
    escalation_id: escalation.id,
    proposals: fileProposals,
    summary: result.text,
  };
  if (result.truncated) response.truncated = true;
  return response;
}

interface ParsedToolInput {
  ok: true;
  path: string;
  new_content: string;
  rationale: string;
}

function parseToolInput(input: unknown):
  | ParsedToolInput
  | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Tool input must be an object.' };
  }
  const obj = input as Record<string, unknown>;
  const p = obj['path'];
  const c = obj['new_content'];
  const r = obj['rationale'];
  if (typeof p !== 'string' || p.length === 0) {
    return { ok: false, error: 'Tool input is missing `path` (string).' };
  }
  if (typeof c !== 'string') {
    return { ok: false, error: 'Tool input is missing `new_content` (string).' };
  }
  if (typeof r !== 'string' || r.trim().length === 0) {
    return { ok: false, error: 'Tool input is missing `rationale` (non-empty string).' };
  }
  return { ok: true, path: p, new_content: c, rationale: r };
}

/**
 * Apply a multi-file proposal atomically. Validates every path + frontmatter,
 * writes all files (best-effort revert on partial failure), then commits the
 * whole set as ONE operator-attributed commit with a `Co-Authored-By: Praxis
 * Role` trailer.
 *
 * Atomic-apply semantics:
 *   - Pre-flight: every proposal must pass path / allowlist / frontmatter checks
 *     before we touch disk.
 *   - Write loop: tmp + rename per file. If any rename fails, we attempt to
 *     restore the prior contents of files we already wrote (best-effort — the
 *     temp files for failed renames are cleaned up automatically by atomicWrite).
 *   - Commit: one git commit covering all changed paths. If commit fails (no
 *     git identity, hook rejection), the files are already on disk; we surface
 *     `commit_warning` rather than rolling back the writes — the operator can
 *     review and commit by hand.
 */
export async function applyChange(roleHome: string, req: ApplyRequest): Promise<ApplyResponse> {
  if (req.proposals.length === 0) {
    throw new CoauthorValidationError('No proposals to apply.');
  }

  // Re-anchor to the escalation so the audit story stays intact.
  const escalation = await loadEscalation(roleHome, req.escalation_id);

  // Pre-flight: validate every proposal before any disk write.
  interface Prepared {
    relativePath: string;
    absPath: string;
    kind: FileProposalKind;
    proposed_content: string;
    /** Prior content on disk before the apply — used for revert on partial failure. */
    priorContent: string | null;
  }
  const seenPaths = new Set<string>();
  const prepared: Prepared[] = [];
  for (const p of req.proposals) {
    if (seenPaths.has(p.path)) {
      throw new CoauthorValidationError(`Duplicate proposal for path: ${p.path}`);
    }
    seenPaths.add(p.path);
    const kind = classifyAndAssertPath(p.path);
    const abs = resolveInside(roleHome, p.path);
    if (p.proposed_content.length === 0) {
      throw new CoauthorValidationError(`Refusing empty proposed content for ${p.path}.`);
    }
    let prior: string | null = null;
    if (await fileExists(abs)) {
      prior = await fs.readFile(abs, 'utf-8');
      if (hasFrontmatter(prior) && !hasFrontmatter(p.proposed_content)) {
        throw new CoauthorValidationError(
          `Refusing apply: ${p.path} has a \`---\` frontmatter block on disk, proposed content does not.`,
        );
      }
    }
    prepared.push({
      relativePath: p.path,
      absPath: abs,
      kind,
      proposed_content: p.proposed_content,
      priorContent: prior,
    });
  }

  // Write phase. Track what we've written so we can attempt revert on failure.
  const written: Prepared[] = [];
  try {
    for (const p of prepared) {
      await atomicWrite(p.absPath, p.proposed_content);
      written.push(p);
    }
  } catch (writeError) {
    // Best-effort revert: restore prior contents for each file we already
    // wrote. If a file had no prior content (created from scratch), unlink it.
    for (const w of written) {
      try {
        if (w.priorContent === null) {
          await fs.unlink(w.absPath).catch(() => {});
        } else {
          await atomicWrite(w.absPath, w.priorContent);
        }
      } catch {
        // Best-effort only — the operator can recover from disk if needed.
      }
    }
    const msg = writeError instanceof Error ? writeError.message : String(writeError);
    throw new Error(`Apply failed mid-write (attempted revert): ${msg}`);
  }

  // All writes succeeded. Build a single commit covering every path.
  const scope = scopeForProposals(prepared.map((p) => p.kind));
  const subject = `apply proposal for ${shortSummary(escalation.title)} (#${escalation.id})`;
  const bodyLines: string[] = [];
  bodyLines.push(`Applied co-authored multi-file change for escalation ${escalation.id}.`);
  bodyLines.push('');
  bodyLines.push(`Escalation: ${escalation.id} (${escalation.kind})`);
  bodyLines.push(`Title: ${escalation.title}`);
  bodyLines.push('');
  bodyLines.push('Files changed:');
  // The ApplyRequest payload is intentionally minimal (path + final content).
  // Rationales from the propose step aren't carried forward because the
  // operator may have edited the content inline before applying — the model's
  // original "why" is no longer authoritative for the final bytes.
  for (const proposal of req.proposals) {
    bodyLines.push(`  - ${proposal.path}`);
  }
  bodyLines.push('');
  bodyLines.push('Co-Authored-By: Praxis Role <role@praxis.local>');

  const filePaths = prepared.map((p) => p.relativePath);
  const commit = await commitChange({
    roleHome,
    actor: 'operator',
    filePaths,
    scope,
    subject,
    body: bodyLines.join('\n'),
  });

  if (!commit.committed || !commit.sha) {
    const result: ApplyResponse = {
      commit_sha: '',
      commit_short_sha: '',
      files_changed: filePaths,
    };
    if (commit.warning) result.commit_warning = commit.warning;
    return result;
  }

  const result: ApplyResponse = {
    commit_sha: commit.sha,
    commit_short_sha: commit.shortSha ?? commit.sha.slice(0, 7),
    files_changed: filePaths,
  };
  if (commit.warning) result.commit_warning = commit.warning;
  return result;
}

/**
 * Pick a conventional-commit scope for a multi-file apply. If every proposal
 * lands on the same kind, use that scope. Otherwise use `coauthor` so the log
 * line still reads cleanly.
 */
function scopeForProposals(kinds: FileProposalKind[]): string {
  if (kinds.length === 0) return 'coauthor';
  const first = kinds[0];
  if (kinds.every((k) => k === first)) {
    switch (first) {
      case 'persona':
        return 'persona';
      case 'claude-md':
        return 'claude-md';
      case 'verb':
        return 'verb';
      case 'lib':
        return 'lib';
    }
  }
  return 'coauthor';
}

function shortSummary(title: string): string {
  const cleaned = title.trim().replace(/\s+/g, ' ');
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

// Re-export the iteration cap so tests can assert against the same constant.
export { MAX_PROPOSAL_ITERATIONS };
