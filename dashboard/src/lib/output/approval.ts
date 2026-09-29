import { simpleGit } from 'simple-git';

import type { OutputStatus } from './types';

/**
 * Operator approval for drafts.
 *
 * `ready` is the "approved to act on" status, but both the operator (via
 * `POST /api/output/...`) and the role (via `update_output_status`) can set
 * it. The status field alone therefore doesn't prove operator approval — the
 * author of the commit that set `ready` does. Operator writes commit as the
 * repo's git identity; role writes commit as `role@praxis.local`.
 */

/** Synthetic author email for autonomous (role) commits — see lib/audit.ts. */
const ROLE_AUTHOR_EMAIL = 'role@praxis.local';

/**
 * Matches a frontmatter `status: ready` line (optionally quoted). Passed to
 * `git log -G`, which compiles it as a POSIX extended regex with newline
 * anchoring, so `^`/`$` bind to line boundaries.
 */
const READY_LINE_RE = `^status:[[:space:]]*['"]?ready['"]?[[:space:]]*$`;

/** Which draft-view controls to render for a given status. */
export interface DraftActions {
  canApprove: boolean;
  canMarkSent: boolean;
  approved: boolean;
}

export function draftActionsFor(status: OutputStatus): DraftActions {
  return {
    canApprove: status === 'draft' || status === 'review',
    canMarkSent: status === 'draft' || status === 'review' || status === 'ready',
    approved: status === 'ready',
  };
}

/** The commit that most recently set `status: ready` on an output file. */
export interface ReadyCommit {
  authorName: string;
  authorEmail: string;
  /** Strict ISO 8601 author date. */
  date: string;
  /** False when the role set `ready` itself. */
  byOperator: boolean;
}

/**
 * Find the most recent commit whose diff added or removed the `status: ready`
 * line in `relativePath`. Call it only when the file is currently `ready`:
 * the latest such commit is then the one that set it. Body edits that leave
 * the status line alone don't match, so they never mask the approver.
 *
 * Returns null when there's no repo, no matching commit, or any git error —
 * never throws.
 */
export async function loadReadyCommit(
  roleHome: string,
  relativePath: string,
): Promise<ReadyCommit | null> {
  const git = simpleGit(roleHome);
  try {
    if (!(await git.checkIsRepo())) return null;
    const out = await git.raw([
      'log',
      '--max-count=1',
      `-G${READY_LINE_RE}`,
      '--pretty=format:%an%x1f%ae%x1f%aI',
      '--',
      relativePath,
    ]);
    const [authorName = '', authorEmail = '', date = ''] = out.trim().split('\x1f');
    if (authorEmail.length === 0) return null;
    return {
      authorName,
      authorEmail,
      date,
      byOperator: authorEmail !== ROLE_AUTHOR_EMAIL,
    };
  } catch {
    return null;
  }
}
