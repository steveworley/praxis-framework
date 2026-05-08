import type { ActivityEntry } from './activity-loader.ts';

/**
 * Decision-shape view of an `ActivityEntry`. All fields are required so the
 * renderer can rely on them — use `toDecisionView` to coerce a raw entry into
 * this shape with safe fallbacks.
 */
export interface DecisionView {
  decisionType: string;
  chosen: string;
  considered: string;
  rationale: string;
  confidence: string;
  confidenceClass: 'high' | 'medium' | 'low' | 'unknown';
}

/**
 * Type guard: is this entry shaped like a decision? We treat any entry whose
 * `action === 'decision'` as a decision regardless of which extras are
 * actually present — the rendering code falls back gracefully when a field
 * is missing.
 */
export function isDecisionEntry(entry: ActivityEntry): boolean {
  return typeof entry.action === 'string' && entry.action === 'decision';
}

/**
 * Project a raw activity entry into a `DecisionView` with safe string
 * fallbacks. Missing fields collapse to empty strings so the caller can
 * cheaply ask "is this present?" via `length > 0`.
 */
export function toDecisionView(entry: ActivityEntry): DecisionView {
  const decisionType = stringOrEmpty(entry.decision_type);
  const chosen = stringOrEmpty(entry.chosen);
  const considered = stringOrEmpty(entry.considered);
  const rationale = stringOrEmpty(entry.rationale);
  const confidence = stringOrEmpty(entry.confidence);
  return {
    decisionType,
    chosen,
    considered,
    rationale,
    confidence,
    confidenceClass: classifyConfidence(confidence),
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function classifyConfidence(value: string): DecisionView['confidenceClass'] {
  const v = value.toLowerCase();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'unknown';
}
