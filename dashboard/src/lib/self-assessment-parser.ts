import type { MemoryEntry } from './memory-loader.ts';

/**
 * Self-assessment memory entries. The role's reflection prompt instructs it
 * to write a `Criteria self-assessment YYYY-MM-DD` entry at end-of-run, one
 * H2 per declared success criterion, with `**Status**` and `**Reasoning**`
 * lines underneath:
 *
 * ```markdown
 * ## <criterion text exactly as declared in persona.md>
 *
 * **Status**: <green | amber | red | unsure>
 * **Reasoning**: <one or two sentences>
 * ```
 *
 * The H2 text is the binding contract — it must match a declared criterion
 * verbatim for the dashboard to surface the assessment against it.
 */

export type CriterionStatusValue = 'green' | 'amber' | 'red' | 'unsure';

const VALID_STATUSES: ReadonlySet<string> = new Set(['green', 'amber', 'red', 'unsure']);

const SELF_ASSESSMENT_TITLE_PREFIX = 'Criteria self-assessment';

export interface CriterionStatus {
  /** H2 text from the entry — should match a declared criterion exactly. */
  criterion: string;
  status: CriterionStatusValue;
  reasoning: string;
  /** ISO date from the entry's `updated` or `created` frontmatter field. */
  assessedAt: string;
}

/**
 * Walk H2 sections in a self-assessment entry's body and pull out each
 * criterion's status + reasoning. Sections with a missing or malformed
 * `**Status**:` value are dropped rather than crashing — the parser stays
 * tolerant of role-authored markdown that doesn't fit the schema.
 *
 * The match is strict on field names (`**Status**:` / `**Reasoning**:`
 * case-sensitive) so the role learns the format by failing visibly when it
 * drifts.
 */
export function parseSelfAssessment(entry: MemoryEntry): CriterionStatus[] {
  const out: CriterionStatus[] = [];
  const sections = splitH2Sections(entry.body);
  for (const section of sections) {
    const criterion = section.heading.trim();
    if (criterion.length === 0) continue;
    const status = extractStatus(section.body);
    if (!status) continue;
    const reasoning = extractReasoning(section.body);
    out.push({
      criterion,
      status,
      reasoning,
      assessedAt: entry.updated ?? entry.created ?? '',
    });
  }
  return out;
}

interface H2Section {
  heading: string;
  body: string;
}

function splitH2Sections(body: string): H2Section[] {
  const lines = body.split('\n');
  const sections: H2Section[] = [];
  let current: H2Section | null = null;
  for (const rawLine of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(rawLine);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1] ?? '', body: '' };
      continue;
    }
    if (current) {
      current.body += `${rawLine}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function extractStatus(sectionBody: string): CriterionStatusValue | null {
  const match = /^\*\*Status\*\*:\s*(\S+)\s*$/m.exec(sectionBody);
  if (!match) return null;
  const value = (match[1] ?? '').trim().toLowerCase();
  if (!VALID_STATUSES.has(value)) return null;
  return value as CriterionStatusValue;
}

function extractReasoning(sectionBody: string): string {
  const match = /^\*\*Reasoning\*\*:\s*(.+?)\s*$/m.exec(sectionBody);
  if (!match) return '';
  return (match[1] ?? '').trim();
}

/**
 * Filter memory entries to the self-assessment subset. Entries qualify when
 * their title starts with `Criteria self-assessment` (case-sensitive — the
 * prompt instructs the role to use that exact prefix).
 */
export function isSelfAssessmentEntry(entry: MemoryEntry): boolean {
  return entry.title.startsWith(SELF_ASSESSMENT_TITLE_PREFIX);
}

/**
 * Aggregate self-assessment entries into a per-criterion timeline. Returns a
 * Map keyed by criterion text where each value is the list of statuses for
 * that criterion, newest first. Use this to surface "latest status" plus a
 * trend strip on the `/health` page.
 *
 * Criteria declared in `persona.md` but absent from every assessment don't
 * appear in the map — callers should fall back to an "unsure / no
 * assessment yet" placeholder for those.
 */
export function getLatestSelfAssessmentsByCriterion(
  memoryEntries: MemoryEntry[],
): Map<string, CriterionStatus[]> {
  const selfAssessments = memoryEntries.filter(isSelfAssessmentEntry);
  // Sort newest first so the per-criterion list reads newest → oldest. The
  // memory loader already sorts by `updated` desc, but we re-sort here so
  // the helper is independent of caller ordering.
  selfAssessments.sort((a, b) => {
    const ax = a.updated ?? a.created ?? '';
    const bx = b.updated ?? b.created ?? '';
    return bx.localeCompare(ax);
  });

  const byCriterion = new Map<string, CriterionStatus[]>();
  for (const entry of selfAssessments) {
    for (const status of parseSelfAssessment(entry)) {
      const list = byCriterion.get(status.criterion);
      if (list) {
        list.push(status);
      } else {
        byCriterion.set(status.criterion, [status]);
      }
    }
  }
  return byCriterion;
}
