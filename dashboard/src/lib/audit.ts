import fs from 'node:fs/promises';
import path from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * Per-mutation audit-log commits.
 *
 * Every constitutional / interior write the dashboard makes — the role's chat
 * tools and the operator's triage actions — should land as a git commit on the
 * role's repo. That gives operators a real `git log` of the role's growth and
 * `git revert <sha>` as a single-step rollback.
 *
 * Design points:
 *
 *  - **Two synthetic actors.** The role's autonomous writes commit as
 *    `Praxis Role <role@praxis.local>`; the operator's triage actions commit as
 *    the role repo's configured `user.name`/`user.email`, falling back to a
 *    synthetic `Operator <operator@praxis.local>` when the operator hasn't set
 *    a git identity. This keeps `git log --author=` filtering honest.
 *  - **Auto-init.** If the role home isn't a git repo, we initialise one and
 *    plant an `Operator`-attributed baseline commit before doing the requested
 *    commit. The framework's autonomy story rests on git being present;
 *    silently initialising is friendlier than refusing and confusing the
 *    operator on a fresh role.
 *  - **File-scoped staging.** We `git add -- <paths>` so an in-flight unrelated
 *    operator edit in another file doesn't get sucked into our commit. If the
 *    named files have nothing staged after `git add` (e.g. content unchanged
 *    from the index), we return `{committed: false}` cleanly without erroring.
 *  - **Soft failure.** Commit errors don't propagate to callers. The caller's
 *    primary operation (the disk write) already succeeded; an audit-log gap is
 *    a recoverable warning, not a failure. The caller surfaces the warning
 *    through its own result envelope so operators can see why the SHA is
 *    missing.
 *  - **No GPG signing, no hook bypass surprises.** We commit with
 *    `--no-gpg-sign` so the operator's shell config (signed commits, etc.)
 *    doesn't fight us, and we pass author/committer identities inline so we
 *    never need to mutate the role's `git config`.
 */

export type AuditActor = 'role' | 'operator';

export interface CommitOptions {
  /** Role home (absolute path). Where the git repo lives. */
  roleHome: string;
  /** Who's making the change — drives the author identity. */
  actor: AuditActor;
  /** Paths to stage, relative to roleHome. Empty means "stage nothing" → no-op. */
  filePaths: string[];
  /** Conventional-commit scope, e.g. 'memory', 'escalation', 'triage'. */
  scope: string;
  /** Conventional-commit type. Defaults to 'role' for role, 'operator' for operator. */
  type?: string;
  /** Short subject after `<type>(<scope>): `. */
  subject: string;
  /** Optional commit body. */
  body?: string;
}

export interface CommitResult {
  /** True iff a new commit was actually created. */
  committed: boolean;
  /** Full SHA of the new commit when `committed` is true. */
  sha?: string;
  /** Short SHA (first 7 chars). Convenience for inline rendering. */
  shortSha?: string;
  /** Set when the commit was skipped or failed in a recoverable way. */
  warning?: string;
}

/** Synthetic identity for autonomous (role) writes. */
const ROLE_AUTHOR = 'Praxis Role <role@praxis.local>';
const ROLE_AUTHOR_NAME = 'Praxis Role';
const ROLE_AUTHOR_EMAIL = 'role@praxis.local';

/** Fallback identity for operator writes when no git identity is configured. */
const FALLBACK_OPERATOR_NAME = 'Operator';
const FALLBACK_OPERATOR_EMAIL = 'operator@praxis.local';

/**
 * Commit the given files to the role's repo with audit-trail attribution.
 *
 * Never throws. On any failure (no repo + can't init, commit conflict, etc.)
 * returns `{committed: false, warning}` so the caller can surface the gap
 * without blocking the user's primary action.
 */
export async function commitChange(opts: CommitOptions): Promise<CommitResult> {
  try {
    return await commitChangeInner(opts);
  } catch (error: unknown) {
    return { committed: false, warning: `audit log skipped: ${errorMessage(error)}` };
  }
}

async function commitChangeInner(opts: CommitOptions): Promise<CommitResult> {
  const { roleHome, actor, filePaths, scope, subject } = opts;

  if (filePaths.length === 0) {
    return { committed: false, warning: 'audit log skipped: no paths to commit' };
  }

  const git = simpleGit(roleHome);

  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    isRepo = false;
  }

  if (!isRepo) {
    const initResult = await initBaseline(git, roleHome, filePaths);
    if (!initResult.ok) {
      return { committed: false, warning: initResult.warning };
    }
  }

  // Identity for this commit.
  const identity = await resolveIdentity(git, actor);

  // Stage only the named paths. `git add -A -- <paths>` stages additions
  // *and* deletions for those paths — important for actions like
  // acceptProposedVerb which renames verbs/proposed/<slug>.md into
  // verbs/<slug>.md (the rename surfaces as a delete + create pair).
  try {
    await git.raw(['add', '-A', '--', ...filePaths]);
  } catch (error: unknown) {
    return {
      committed: false,
      warning: `audit log skipped: failed to stage paths (${errorMessage(error)})`,
    };
  }

  // If nothing in the staged index changed for these paths, bail cleanly —
  // the caller's write didn't actually change file content. Compare staged
  // vs HEAD restricted to the paths.
  const hasStagedChanges = await pathsHaveStagedChanges(git, filePaths);
  if (!hasStagedChanges) {
    return { committed: false, warning: 'audit log skipped: no changes to commit' };
  }

  const message = renderMessage(opts, actor);
  const author = identity.author;

  // Commit with explicit author + committer. `-c user.name=...` /
  // `-c user.email=...` sets the committer for this invocation without
  // touching the repo's config. `--no-gpg-sign` keeps the operator's signed-
  // commit config from interfering. Trailing `-- <paths>` restricts the
  // commit to staged changes for those paths only, so an unrelated
  // operator-staged edit elsewhere doesn't ride along.
  const commitArgs: string[] = [
    '-c',
    `user.name=${identity.committerName}`,
    '-c',
    `user.email=${identity.committerEmail}`,
    '-c',
    'commit.gpgsign=false',
    'commit',
    `--author=${author}`,
    '--no-gpg-sign',
    '-m',
    message.subject,
  ];
  if (message.body) {
    commitArgs.push('-m', message.body);
  }
  commitArgs.push('--', ...filePaths);

  try {
    await git.raw(commitArgs);
  } catch (error: unknown) {
    return {
      committed: false,
      warning: `audit log skipped: commit failed (${errorMessage(error)})`,
    };
  }

  // Read back the new HEAD SHA.
  let sha = '';
  try {
    sha = (await git.revparse(['HEAD'])).trim();
  } catch {
    return { committed: true, warning: 'commit landed but could not read SHA' };
  }

  const result: CommitResult = { committed: true, sha };
  if (sha.length >= 7) result.shortSha = sha.slice(0, 7);
  if (identity.warning) result.warning = identity.warning;
  return result;
}

interface ResolvedIdentity {
  /** Author string in `Name <email>` form, passed via `--author`. */
  author: string;
  /** Committer name for this commit (via `-c user.name=`). */
  committerName: string;
  /** Committer email for this commit (via `-c user.email=`). */
  committerEmail: string;
  /** Optional warning to bubble up (e.g. "operator git identity not configured"). */
  warning?: string;
}

async function resolveIdentity(git: SimpleGit, actor: AuditActor): Promise<ResolvedIdentity> {
  if (actor === 'role') {
    return {
      author: ROLE_AUTHOR,
      committerName: ROLE_AUTHOR_NAME,
      committerEmail: ROLE_AUTHOR_EMAIL,
    };
  }

  // Operator: read the repo's `user.name`/`user.email`. Fall back when unset.
  let name = '';
  let email = '';
  try {
    name = (await git.raw(['config', '--get', 'user.name'])).trim();
  } catch {
    name = '';
  }
  try {
    email = (await git.raw(['config', '--get', 'user.email'])).trim();
  } catch {
    email = '';
  }
  if (name.length > 0 && email.length > 0) {
    return {
      author: `${name} <${email}>`,
      committerName: name,
      committerEmail: email,
    };
  }
  return {
    author: `${FALLBACK_OPERATOR_NAME} <${FALLBACK_OPERATOR_EMAIL}>`,
    committerName: FALLBACK_OPERATOR_NAME,
    committerEmail: FALLBACK_OPERATOR_EMAIL,
    warning:
      'audit log: operator git identity is not set — set user.name/user.email or these commits will appear as anonymous Operator',
  };
}

interface BaselineInitResult {
  ok: boolean;
  warning?: string;
}

/**
 * Initialise a git repo at `roleHome` and lay down a baseline commit that
 * captures whatever's there today (except the paths the caller is about to
 * commit — those are intentionally left as a new staged change so the
 * follow-up commit has something to land). Attributed to the operator so the
 * role's later commits stand out against an operator-anchored history.
 */
async function initBaseline(
  git: SimpleGit,
  roleHome: string,
  excludePaths: string[],
): Promise<BaselineInitResult> {
  try {
    await git.init();
  } catch (error: unknown) {
    return { ok: false, warning: `audit log skipped: git init failed (${errorMessage(error)})` };
  }

  // Plant a .gitignore if there isn't one.
  const gitignorePath = path.join(roleHome, '.gitignore');
  if (!(await fileExists(gitignorePath))) {
    const defaultIgnore = ['node_modules/', '.DS_Store', '.praxis/', ''].join('\n');
    try {
      await fs.writeFile(gitignorePath, defaultIgnore, 'utf-8');
    } catch {
      // Non-fatal — `git add -A` will still work without the file.
    }
  }

  // Stage everything currently in the role home as the baseline...
  try {
    await git.add(['-A', '.']);
  } catch (error: unknown) {
    return {
      ok: false,
      warning: `audit log skipped: baseline staging failed (${errorMessage(error)})`,
    };
  }

  // ...but unstage the caller's target paths so they remain as a fresh
  // change for the audit commit that follows. Without this step, the audit
  // commit would have nothing to land because the baseline already absorbed
  // the new file.
  if (excludePaths.length > 0) {
    try {
      await git.raw(['rm', '--cached', '--quiet', '--', ...excludePaths]);
    } catch {
      // Best-effort: if `git rm --cached` fails (e.g. path wasn't actually
      // added because it doesn't exist on disk yet), continue. The diff
      // check below the baseline will decide whether there's anything to
      // commit.
    }
  }

  const identity = await resolveIdentity(git, 'operator');
  try {
    await git.raw([
      '-c',
      `user.name=${identity.committerName}`,
      '-c',
      `user.email=${identity.committerEmail}`,
      '-c',
      'commit.gpgsign=false',
      'commit',
      `--author=${identity.author}`,
      '--no-gpg-sign',
      '--allow-empty',
      '-m',
      'chore: praxis init audit baseline',
    ]);
  } catch (error: unknown) {
    return {
      ok: false,
      warning: `audit log skipped: baseline commit failed (${errorMessage(error)})`,
    };
  }
  return { ok: true };
}

/**
 * Build the conventional-commit message — `<type>(<scope>): <subject>` with an
 * optional blank-line-separated body. We default `type` based on actor:
 *   - role     → `role` (e.g. `role(memory): note mary-chen-prefers-async`)
 *   - operator → `operator` (e.g. `operator(triage): accept escalation foo`)
 *
 * Callers can override via `opts.type`.
 */
function renderMessage(opts: CommitOptions, actor: AuditActor): { subject: string; body?: string } {
  const type = opts.type ?? (actor === 'role' ? 'role' : 'operator');
  const subject = `${type}(${opts.scope}): ${opts.subject}`;
  const result: { subject: string; body?: string } = { subject };
  if (opts.body && opts.body.trim().length > 0) result.body = opts.body.trim();
  return result;
}

async function pathsHaveStagedChanges(git: SimpleGit, paths: string[]): Promise<boolean> {
  try {
    // `--name-only` is more reliable than `--quiet` because simple-git's
    // raw() doesn't surface diff's exit-code-1 "has changes" signal. We just
    // look for any non-blank line in the output.
    const out = await git.raw(['diff', '--cached', '--name-only', '--', ...paths]);
    return out.split('\n').some((line) => line.trim().length > 0);
  } catch {
    // If diff itself fails (e.g. no HEAD yet), be conservative and assume we
    // do have changes so the commit attempt below can speak for itself.
    return true;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
