/**
 * Co-authoring constitutional changes — model-led, operator-applied.
 *
 * The operator accepts an `improvement` escalation, then asks the role's model
 * to draft a proposal. The model decides which file(s) to touch — persona.md,
 * CLAUDE.md, a live verb, a non-constitutional lib — and returns one or more
 * file proposals. The operator reviews diffs, optionally drops a file or edits
 * inline, then applies. Every apply is one operator-attributed commit with a
 * `Co-Authored-By: Praxis Role` trailer so the audit story shows both the human
 * decision and the model's drafting hand.
 *
 * The shift from the v1 picker-and-directive flow: the model now picks the
 * target(s) and proposes a coherent multi-file change set. The operator is
 * reviewer + actor, not framework expert.
 */

/**
 * Coarse classification of a proposed file's role in the constitution. Drives
 * the kind label in the review UI and the conventional-commit scope chosen at
 * apply time. Not user-supplied — derived from the path at proposal time.
 */
export type FileProposalKind = 'persona' | 'claude-md' | 'verb' | 'lib';

export interface ProposeRequest {
  /** The accepted improvement escalation this proposal addresses. Required so
   *  every co-authoring session is anchored to an audit-visible request. */
  escalation_id: string;
  /** Optional operator guidance — used for re-drafts when the first proposal
   *  didn't land. Empty/absent on the initial call. */
  hint?: string;
}

export interface FileProposal {
  /** Relative path inside the role home, e.g. `persona.md` or `verbs/escalate.md`. */
  path: string;
  /** File content as it exists on disk now. Empty string if creating a new file. */
  current_content: string;
  /** Full file content the model proposes. */
  proposed_content: string;
  /** Unified diff (current → proposed), computed server-side. */
  diff_unified: string;
  /** One-sentence rationale from the model for THIS file. */
  rationale: string;
  /** Coarse classification — picks the kind label and the commit scope. */
  kind: FileProposalKind;
}

export interface ProposeResponse {
  escalation_id: string;
  /** 1..N file proposals. Multi-file proposals land as a single atomic commit. */
  proposals: FileProposal[];
  /** The model's one-paragraph framing of the overall proposal set. */
  summary: string;
  /** True when the tool-use loop hit the iteration cap before the model
   *  said it was done. The proposals are still usable but may be incomplete. */
  truncated?: boolean;
}

/** Per-file payload the operator hands back at apply time. */
export interface ApplyFileProposal {
  path: string;
  /** The final content — may differ from the original proposal if the operator
   *  edited inline before applying. */
  proposed_content: string;
}

export interface ApplyRequest {
  escalation_id: string;
  /** 1..N files to apply atomically. The operator may have dropped some
   *  proposals from the original set; only what's here is written/committed. */
  proposals: ApplyFileProposal[];
}

export interface ApplyResponse {
  commit_sha: string;
  commit_short_sha: string;
  /** Paths the commit changed, in apply order. */
  files_changed: string[];
  /** Set when the audit commit was skipped or surfaced a non-fatal warning. */
  commit_warning?: string;
}

/** Surfaced when target resolution / path validation refuses. */
export class CoauthorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoauthorValidationError';
  }
}

/** Surfaced when the underlying file (persona/CLAUDE.md/known verb) is missing. */
export class CoauthorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoauthorNotFoundError';
  }
}
