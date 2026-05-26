/**
 * Formats backend 422 validation issues from `POST /api/setup/role` into
 * human-readable labels for the setup wizard. The API returns issues with
 * dotted zod paths (e.g. `initial_verbs.2.description.0`); this turns them
 * into operator-friendly labels (e.g. "Initial verbs › item 3 › description").
 *
 * Pure and dependency-free so it can be unit-tested and bridged onto `window`
 * for the wizard's inline Alpine script (which cannot import modules).
 */

/** A raw validation issue as returned by the setup API. */
export interface SetupValidationIssue {
  path: string;
  message: string;
}

/** A validation issue with a humanized label, ready for display. */
export interface FormattedSetupIssue {
  label: string;
  message: string;
}

/**
 * Nice labels for known wizard fields. Top-level sections and common leaf
 * keys; anything unmapped falls back to underscore-humanization.
 */
const FIELD_LABELS: Record<string, string> = {
  // Top-level sections
  organisation: 'Organisation',
  role_definition: 'Role definition',
  identity: 'Identity',
  voice_traits: 'Voice traits',
  capabilities: 'Capabilities',
  accountabilities: 'Accountabilities',
  success_criteria: 'Success criteria',
  inhibitions: 'Inhibitions',
  initial_verbs: 'Initial verbs',
  // Common leaf keys
  role_name: 'Role name',
  one_sentence_purpose: 'Purpose',
  description: 'description',
  slug: 'slug',
};

function isNumericSegment(segment: string): boolean {
  return segment.length > 0 && /^\d+$/.test(segment);
}

function labelForSegment(segment: string): string {
  if (isNumericSegment(segment)) {
    // Wizard rows are numbered from 01, so a zero-based index maps to item N+1.
    return `item ${Number(segment) + 1}`;
  }
  const known = FIELD_LABELS[segment];
  if (known !== undefined) {
    return known;
  }
  return segment.replace(/_/g, ' ');
}

/** Humanizes a dotted issue path into a " › "-joined label. */
export function humanizeIssuePath(path: string): string {
  if (path.length === 0) {
    return 'Form';
  }
  const segments = path.split('.');
  // A trailing numeric segment indexes into a leaf array (e.g. zod targeting
  // element 0 of a string list); it carries no useful detail for an operator,
  // so drop it. Keep a leading "Form" if that leaves nothing behind.
  while (segments.length > 1 && isNumericSegment(segments[segments.length - 1] ?? '')) {
    segments.pop();
  }
  return segments.map(labelForSegment).join(' › ');
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Formats an unknown payload (expected: the API's `issues[]` array) into
 * display-ready issues. Defensive: non-array input yields `[]`, and
 * non-object or partial entries are tolerated.
 */
export function formatSetupValidationIssues(input: unknown): FormattedSetupIssue[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const formatted: FormattedSetupIssue[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = coerceString(record['path']);
    const message = coerceString(record['message']);
    formatted.push({ label: humanizeIssuePath(path), message });
  }
  return formatted;
}
