import fs from 'node:fs/promises';
import path from 'node:path';

import type { EscalationDetail } from '@/lib/triage.js';

/**
 * Build the system prompt + user content for the model-led proposal call.
 *
 * The model gets:
 *   - The escalation that motivated the change (kind, urgency, title, body)
 *   - Optional operator hint (re-drafts only)
 *   - The role's current constitutional files, each as a fenced block headed
 *     by its path
 *
 * The model then calls `propose_file_change` one or more times via tool use,
 * then writes a brief summary paragraph as its final text output.
 *
 * Role-file context assembly trade-off: a Sam-shaped role (~15–30 KB) fits
 * comfortably in one prompt. For larger roles we truncate `lib/*` first (those
 * are usually the largest and the model doesn't need every YAML row to draft a
 * persona/tone change). The truncation kicks in at ~50 KB total — well below
 * the model's context window but enough to keep the prompt readable in logs.
 */

const MAX_CONTEXT_BYTES = 50_000;

export interface BuildPromptOptions {
  escalation: EscalationDetail;
  /** Optional operator guidance for re-drafts. */
  hint?: string | undefined;
  /** Role files to include in context, in display order. */
  files: ReadonlyArray<RoleFileForContext>;
}

export interface RoleFileForContext {
  /** Relative path inside the role home (e.g. `persona.md`, `verbs/escalate.md`). */
  path: string;
  content: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Files that were included in the context (post-truncation). The caller can
   *  surface this in tests / logs to confirm what the model actually saw. */
  filesIncluded: string[];
}

/**
 * Compose the system + user content. Returns the truncated file list so the
 * caller can log it.
 */
export function buildCoauthorPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const system = SYSTEM_PROMPT;

  const { files: usedFiles, truncatedLibCount } = truncateForContext(opts.files);

  const sections: string[] = [];
  sections.push('## Escalation that motivated this change');
  sections.push('');
  sections.push(`- id: ${opts.escalation.id}`);
  sections.push(`- kind: ${opts.escalation.kind}`);
  sections.push(`- urgency: ${opts.escalation.urgency}`);
  sections.push(`- title: ${opts.escalation.title}`);
  sections.push('');
  sections.push(opts.escalation.body.trim());

  if (opts.hint && opts.hint.trim().length > 0) {
    sections.push('');
    sections.push('## Additional operator guidance');
    sections.push('');
    sections.push(opts.hint.trim());
  }

  sections.push('');
  sections.push("## Role's current files");
  sections.push('');
  if (truncatedLibCount > 0) {
    sections.push(
      `(Note: ${truncatedLibCount} \`lib/*\` file(s) omitted to keep the context compact. ` +
        `Ask via re-draft if any are needed.)`,
    );
    sections.push('');
  }

  for (const f of usedFiles) {
    sections.push(`### ${f.path}`);
    sections.push('');
    sections.push('```');
    sections.push(f.content);
    sections.push('```');
    sections.push('');
  }

  sections.push('## Your task');
  sections.push('');
  sections.push(
    'Call `propose_file_change` for each file you want to change. Return the ' +
      'complete new file content (not a patch) and a one-sentence rationale. ' +
      'After all tool calls, write a brief one-paragraph summary describing ' +
      'the overall change you are proposing.',
  );

  return {
    system,
    user: sections.join('\n'),
    filesIncluded: usedFiles.map((f) => f.path),
  };
}

const SYSTEM_PROMPT = [
  'You are helping the operator turn an accepted improvement escalation into specific file changes on the role. You have read access to the role\'s files in context below. Propose 1–N file changes that, taken together, address the escalation. For each proposal, call the `propose_file_change` tool with the full new file content and a one-sentence rationale.',
  '',
  'Constraints:',
  '- Allowed targets: `persona.md`, `CLAUDE.md`, `verbs/<slug>.md` (live verbs only — not `verbs/proposed/`), `lib/<filename>` (non-constitutional libs only — do NOT touch `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, or `lib/tools.yaml`).',
  '- Preserve frontmatter where present.',
  '- Make the minimum set of changes that satisfies the escalation; do not sweep up unrelated improvements.',
  '- If the escalation can be addressed in one file, propose one file. If multiple files would land it more coherently, propose all of them.',
  '- After calling tools, write a brief one-paragraph summary describing the overall change.',
].join('\n');

/**
 * If the combined size of context files exceeds MAX_CONTEXT_BYTES, drop the
 * largest `lib/*` entries first (preserving persona/CLAUDE.md/verbs in full).
 * Returns the surviving set and how many lib files were dropped.
 */
function truncateForContext(files: ReadonlyArray<RoleFileForContext>): {
  files: RoleFileForContext[];
  truncatedLibCount: number;
} {
  const sized = files.map((f) => ({ ...f, bytes: Buffer.byteLength(f.content, 'utf-8') }));
  const total = sized.reduce((sum, f) => sum + f.bytes, 0);
  if (total <= MAX_CONTEXT_BYTES) {
    return { files: sized.map(stripBytes), truncatedLibCount: 0 };
  }

  // Sort lib files by size desc; drop them until we're under the cap.
  const libs = sized
    .filter((f) => f.path.startsWith('lib/'))
    .sort((a, b) => b.bytes - a.bytes);
  const dropped = new Set<string>();
  let running = total;
  for (const f of libs) {
    if (running <= MAX_CONTEXT_BYTES) break;
    dropped.add(f.path);
    running -= f.bytes;
  }
  const surviving = sized.filter((f) => !dropped.has(f.path)).map(stripBytes);
  return { files: surviving, truncatedLibCount: dropped.size };
}

function stripBytes(f: RoleFileForContext & { bytes: number }): RoleFileForContext {
  return { path: f.path, content: f.content };
}

/**
 * Read the role's constitutional files into the shape buildCoauthorPrompt
 * expects. Walks: `persona.md`, `CLAUDE.md`, every `verbs/*.md` (live verbs
 * only — skip `verbs/proposed/`), and every `lib/*.{yaml,yml,md}` except the
 * gated constitutional libs (the model isn't allowed to touch those).
 *
 * Missing files are silently skipped — a fresh role might not have CLAUDE.md
 * or any lib files yet, and the prompt should still work.
 */
export async function readRoleFilesForContext(
  roleHome: string,
): Promise<RoleFileForContext[]> {
  const out: RoleFileForContext[] = [];

  const personaAbs = path.join(roleHome, 'persona.md');
  const personaTxt = await readMaybe(personaAbs);
  if (personaTxt !== null) out.push({ path: 'persona.md', content: personaTxt });

  const claudeAbs = path.join(roleHome, 'CLAUDE.md');
  const claudeTxt = await readMaybe(claudeAbs);
  if (claudeTxt !== null) out.push({ path: 'CLAUDE.md', content: claudeTxt });

  // Live verbs (top-level *.md under verbs/, NOT verbs/proposed/).
  const verbsDir = path.join(roleHome, 'verbs');
  try {
    const entries = await fs.readdir(verbsDir, { withFileTypes: true });
    const verbFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();
    for (const name of verbFiles) {
      const rel = path.posix.join('verbs', name);
      const abs = path.join(roleHome, rel);
      const txt = await readMaybe(abs);
      if (txt !== null) out.push({ path: rel, content: txt });
    }
  } catch {
    // No verbs dir — skip silently.
  }

  // Non-constitutional lib files. Match the same allowlist extensions the
  // tool's apply path accepts.
  const libDir = path.join(roleHome, 'lib');
  try {
    const entries = await fs.readdir(libDir, { withFileTypes: true });
    const libFiles = entries
      .filter((e) => e.isFile() && LIB_EXT_RE.test(e.name))
      .filter((e) => !GATED_LIB_FILES.has(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of libFiles) {
      const rel = path.posix.join('lib', name);
      const abs = path.join(roleHome, rel);
      const txt = await readMaybe(abs);
      if (txt !== null) out.push({ path: rel, content: txt });
    }
  } catch {
    // No lib dir — skip silently.
  }

  return out;
}

const LIB_EXT_RE = /\.(ya?ml|md|json|toml)$/i;
const GATED_LIB_FILES = new Set([
  'customers.yaml',
  'compliance.yaml',
  'autonomy.yaml',
  'tools.yaml',
]);

async function readMaybe(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}
