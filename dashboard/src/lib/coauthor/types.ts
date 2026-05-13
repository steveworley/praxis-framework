/**
 * Co-authoring constitutional changes — the operator-driven path for applying
 * persona / CLAUDE.md / verb / lib edits that originated from an accepted
 * `improvement` escalation. The model is a drafting assistant; the operator
 * is the actor and the commit author.
 *
 * Flow: operator accepts an improvement escalation → opens /triage/draft/<id>
 * → picks a target → writes a directive → the model returns a full proposed
 * file → operator reviews the diff → applies. Every apply commits as the
 * operator with `Co-Authored-By: Praxis Role` so the audit trail shows both
 * the human decision and the model's drafting hand.
 */

/**
 * The closed enum of constitutional surfaces a co-authoring session can
 * target. Anything outside this set is refused at the API boundary — the
 * framework constrains where co-authoring can land.
 */
export type ConstitutionalTarget =
  | { kind: 'persona' }
  | { kind: 'claude-md' }
  | { kind: 'verb'; slug: string }
  | { kind: 'lib'; filename: string };

export interface DraftRequest {
  /** The accepted improvement escalation this draft addresses. Required so
   *  every co-authoring session is anchored to an audit-visible request. */
  escalation_id: string;
  target: ConstitutionalTarget;
  /** Operator's instruction to the model — what specifically should change. */
  directive: string;
}

export interface DraftResponse {
  /** Resolved relative path inside the role home (e.g. `persona.md`). */
  target_path: string;
  current_content: string;
  proposed_content: string;
  /** Unified-diff text computed server-side from current vs proposed. */
  diff_unified: string;
  /** Reserved for a future "what changed and why" pass; empty in v1.
   *  The diff is the rationale until we add a second model call. */
  rationale: string;
}

export interface ApplyRequest {
  escalation_id: string;
  /** Relative path inside the role home. Validated against traversal. */
  target_path: string;
  /** The operator's final version (may include inline edits from the UI). */
  proposed_content: string;
}

export interface ApplyResponse {
  commit_sha: string;
  commit_short_sha: string;
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
