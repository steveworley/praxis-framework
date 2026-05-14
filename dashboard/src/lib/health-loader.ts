import { simpleGit } from 'simple-git';

import { assembleActivity } from './activity-loader.ts';
import { assembleEscalations } from './escalations-loader.ts';
import { assembleMemory, type MemoryEntry } from './memory-loader.ts';
import { parsePersona } from './persona-parser.ts';
import {
  type CriterionStatus,
  type CriterionStatusValue,
  getLatestSelfAssessmentsByCriterion,
} from './self-assessment-parser.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WEEK_COUNT = 4;
const ACTIVITY_WINDOW_DAYS = 30;
const REVERT_WINDOW_DAYS = 30;
const DEFAULT_CRITERION_TREND_LENGTH = 4;
const ROLE_AUTHOR_EMAIL = 'role@praxis.local';
// Pull a generous slice — the page's last-30-days windows are smaller than
// this, but `assembleActivity` returns its own slice and we'd rather discard
// older entries here than have the loader's window silently truncate ours.
const ACTIVITY_FETCH_LIMIT = 5000;
const DEFAULT_LOG_GLOB = '**/logs/*.jsonl';

/**
 * One 7-day bucket in a weekly histogram. `end_date` is the ISO date the
 * bucket ends on (inclusive); `label` is a short "Mar 5" string for the
 * health page's tabular display.
 */
export interface WeeklyBucket {
  end_date: string;
  label: string;
  count: number;
}

export interface MemoryHealth {
  total: number;
  weekly: WeeklyBucket[];
  by_category: Array<{ category: string; count: number }>;
  last_update: string | null;
}

export interface EscalationsHealth {
  total: number;
  counts_by_status: { open: number; resolved: number; accepted: number; declined: number };
  weekly_filed: WeeklyBucket[];
  weekly_resolved: WeeklyBucket[];
  weekly_declined: WeeklyBucket[];
  /**
   * Median time-to-triage in days for escalations that left `open` in the
   * last 28 days. `null` when no triage activity occurred in the window.
   */
  median_time_to_triage_days: number | null;
  /**
   * Sample size behind the median — how many resolved/accepted/declined
   * escalations fell into the 28-day window. Surfaced alongside the median
   * so a single fast triage doesn't read as a stable signal.
   */
  triage_sample_size: number;
}

export interface ToolDistribution {
  tool: string;
  count: number;
}

export interface ActivityHealth {
  total: number;
  by_tool: ToolDistribution[];
  window_days: number;
}

export interface AutonomyHealth {
  role_commits: number;
  revert_commits: number;
  /** Reverts divided by role commits, in [0, 1]. `null` when no role commits. */
  revert_ratio: number | null;
  /** `true` when git isn't usable (no repo, missing binary, etc.). */
  git_unavailable: boolean;
  window_days: number;
}

/**
 * Per-criterion status for the `/health` "Performance against criteria"
 * panel. One row per declared success criterion; `latest` is null when the
 * criterion has never been assessed and the UI should fall back to an
 * "unsure / no assessment yet" placeholder.
 */
export interface CriterionHealth {
  criterion: string;
  latest: CriterionStatus | null;
  /** Last N statuses oldest → newest. Empty when no assessments exist. */
  trend: CriterionStatusValue[];
}

export interface CriteriaHealth {
  /**
   * One entry per declared criterion in `persona.md`. Empty when the persona
   * declares no success criteria — the `/health` page renders a guidance
   * empty state for that case.
   */
  criteria: CriterionHealth[];
  /** How many trend values the loader was asked to emit per criterion. */
  trend_length: number;
}

export interface HealthReport {
  generated_at: string;
  window: {
    weekly_buckets: number;
    weekly_days: number;
    activity_days: number;
    autonomy_days: number;
  };
  memory: MemoryHealth;
  escalations: EscalationsHealth;
  activity: ActivityHealth;
  autonomy: AutonomyHealth;
  criteria: CriteriaHealth;
}

/**
 * Assemble the role-health report for the supervisor's `/health` page.
 * Internally fans out to the existing memory / escalations / activity /
 * autonomy loaders, then aggregates into the textual shapes the page renders.
 *
 * `now` is injectable so tests can pin the windowing — production callers
 * just rely on `Date.now()`. We never re-read the clock mid-flight, so every
 * bucket boundary stays consistent across all four sections.
 */
export async function loadHealth(
  roleHome: string,
  now: number = Date.now(),
): Promise<HealthReport> {
  const [memoryRes, escalationsRes, activityRes, autonomyRes, personaRes] =
    await Promise.allSettled([
      assembleMemory(roleHome),
      assembleEscalations(roleHome),
      assembleActivity(roleHome, DEFAULT_LOG_GLOB, ACTIVITY_FETCH_LIMIT),
      loadAutonomyHealth(roleHome, now),
      parsePersona(roleHome),
    ]);

  const memoryEntries = memoryRes.status === 'fulfilled' ? memoryRes.value : [];
  const escalations =
    escalationsRes.status === 'fulfilled'
      ? escalationsRes.value
      : { entries: [], countsByStatus: { open: 0, resolved: 0, accepted: 0, declined: 0 } };
  const activityEntries = activityRes.status === 'fulfilled' ? activityRes.value : [];
  const autonomy: AutonomyHealth =
    autonomyRes.status === 'fulfilled'
      ? autonomyRes.value
      : {
          role_commits: 0,
          revert_commits: 0,
          revert_ratio: null,
          git_unavailable: true,
          window_days: REVERT_WINDOW_DAYS,
        };
  const declaredCriteria =
    personaRes.status === 'fulfilled' ? personaRes.value.success_criteria : [];

  return {
    generated_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    window: {
      weekly_buckets: DEFAULT_WEEK_COUNT,
      weekly_days: 7,
      activity_days: ACTIVITY_WINDOW_DAYS,
      autonomy_days: REVERT_WINDOW_DAYS,
    },
    memory: buildMemoryHealth(memoryEntries, now),
    escalations: buildEscalationsHealth(escalations, now),
    activity: buildActivityHealth(activityEntries, now),
    autonomy,
    criteria: buildCriteriaHealth(declaredCriteria, memoryEntries),
  };
}

/**
 * Join the persona's declared `success_criteria` to the role's self-
 * assessment memory entries. For each declared criterion we surface the most
 * recent assessment plus the last N statuses oldest → newest for the trend
 * strip. Criteria with no matching assessment show `latest: null` so the UI
 * can render an "unsure / no assessment yet" placeholder.
 *
 * `trendLength` defaults to {@link DEFAULT_CRITERION_TREND_LENGTH}. When
 * fewer than `trendLength` assessments exist for a criterion, the trend
 * array just shortens — we don't pad with placeholders.
 */
export function buildCriteriaHealth(
  declared: string[],
  memoryEntries: MemoryEntry[],
  trendLength: number = DEFAULT_CRITERION_TREND_LENGTH,
): CriteriaHealth {
  const byCriterion = getLatestSelfAssessmentsByCriterion(memoryEntries);
  const criteria: CriterionHealth[] = declared.map((criterion) => {
    const history = byCriterion.get(criterion) ?? [];
    // `history` is newest-first; slice the most-recent `trendLength`, then
    // reverse so the UI reads oldest → newest left → right.
    const trend = history
      .slice(0, trendLength)
      .map((h) => h.status)
      .reverse();
    return {
      criterion,
      latest: history[0] ?? null,
      trend,
    };
  });
  return { criteria, trend_length: trendLength };
}

interface MemoryLike {
  updated: string | null;
  created: string | null;
  category: string;
}

interface EscalationLike {
  status: string;
  created: string | null;
  body: string;
}

interface ActivityLike {
  timestamp?: string;
  action?: string;
  [key: string]: unknown;
}

function buildMemoryHealth(entries: MemoryLike[], now: number): MemoryHealth {
  const weekly = bucketByWeek(
    entries.map((e) => e.updated ?? e.created),
    now,
    DEFAULT_WEEK_COUNT,
  );
  const byCategory = new Map<string, number>();
  for (const e of entries) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
  }
  const sortedCategories = Array.from(byCategory.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.category.localeCompare(b.category);
    });

  const lastUpdate =
    entries.length > 0
      ? entries.reduce<string | null>((acc, e) => {
          const v = e.updated ?? e.created;
          if (!v) return acc;
          if (!acc) return v;
          return v > acc ? v : acc;
        }, null)
      : null;

  return {
    total: entries.length,
    weekly,
    by_category: sortedCategories,
    last_update: lastUpdate,
  };
}

function buildEscalationsHealth(
  result: { entries: EscalationLike[]; countsByStatus: EscalationsHealth['counts_by_status'] },
  now: number,
): EscalationsHealth {
  const filed: (string | null)[] = [];
  const resolved: (string | null)[] = [];
  const declined: (string | null)[] = [];
  const triageDurationsDays: number[] = [];
  const windowStart = now - 28 * MS_PER_DAY;

  for (const e of result.entries) {
    filed.push(e.created);
    const triagedAt = extractOperatorNoteTimestamp(e.body);
    if (e.status === 'resolved' || e.status === 'accepted') {
      resolved.push(triagedAt ?? e.created);
    }
    if (e.status === 'declined') {
      declined.push(triagedAt ?? e.created);
    }
    if (
      (e.status === 'resolved' || e.status === 'accepted' || e.status === 'declined') &&
      e.created &&
      triagedAt
    ) {
      const createdMs = Date.parse(e.created);
      const triagedMs = Date.parse(triagedAt);
      if (
        Number.isFinite(createdMs) &&
        Number.isFinite(triagedMs) &&
        triagedMs >= createdMs &&
        triagedMs >= windowStart
      ) {
        triageDurationsDays.push((triagedMs - createdMs) / MS_PER_DAY);
      }
    }
  }

  return {
    total: result.entries.length,
    counts_by_status: result.countsByStatus,
    weekly_filed: bucketByWeek(filed, now, DEFAULT_WEEK_COUNT),
    weekly_resolved: bucketByWeek(resolved, now, DEFAULT_WEEK_COUNT),
    weekly_declined: bucketByWeek(declined, now, DEFAULT_WEEK_COUNT),
    median_time_to_triage_days: median(triageDurationsDays),
    triage_sample_size: triageDurationsDays.length,
  };
}

function buildActivityHealth(entries: ActivityLike[], now: number): ActivityHealth {
  const windowStart = now - ACTIVITY_WINDOW_DAYS * MS_PER_DAY;
  const counts = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue;
    const tool = toolNameFor(entry);
    if (!tool) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    total += 1;
  }
  const byTool = Array.from(counts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.tool.localeCompare(b.tool);
    });
  return { total, by_tool: byTool, window_days: ACTIVITY_WINDOW_DAYS };
}

/**
 * Returns the tool / action name for an activity entry. The chat tool-use
 * loop emits entries with an `action` field that names the called tool
 * (`write_memory`, `propose_verb`, etc.); decision logs reuse `action:
 * decision` with the verb captured separately in `decision_type`. We
 * collapse both into a single bucket name so the distribution table reads
 * as "the role's recent calls" without splitting decisions by sub-type.
 */
function toolNameFor(entry: ActivityLike): string | null {
  const action = typeof entry.action === 'string' ? entry.action.trim() : '';
  if (action.length === 0) return null;
  return action;
}

async function loadAutonomyHealth(roleHome: string, now: number): Promise<AutonomyHealth> {
  const git = simpleGit(roleHome);
  try {
    if (!(await git.checkIsRepo())) {
      return {
        role_commits: 0,
        revert_commits: 0,
        revert_ratio: null,
        git_unavailable: true,
        window_days: REVERT_WINDOW_DAYS,
      };
    }
  } catch {
    return {
      role_commits: 0,
      revert_commits: 0,
      revert_ratio: null,
      git_unavailable: true,
      window_days: REVERT_WINDOW_DAYS,
    };
  }

  const sinceIso = new Date(now - REVERT_WINDOW_DAYS * MS_PER_DAY).toISOString();
  let roleCount = 0;
  let revertCount = 0;
  try {
    const roleLog = await git.raw([
      'log',
      `--since=${sinceIso}`,
      `--author=${ROLE_AUTHOR_EMAIL}`,
      '--pretty=format:%H',
    ]);
    roleCount = roleLog.split('\n').filter((s) => s.trim().length > 0).length;
  } catch {
    return {
      role_commits: 0,
      revert_commits: 0,
      revert_ratio: null,
      git_unavailable: true,
      window_days: REVERT_WINDOW_DAYS,
    };
  }

  try {
    // `git log --grep=` matches the commit subject *or* body — that's fine
    // here because a revert of a role commit carries the original subject
    // (`Revert "role(memory): note alice"`) on the subject line. Under
    // `--extended-regexp` we escape `(` so the shell doesn't fail with
    // "parentheses not balanced".
    const revertLog = await git.raw([
      'log',
      `--since=${sinceIso}`,
      '--extended-regexp',
      '--grep=^Revert "role\\(',
      '--pretty=format:%H',
    ]);
    revertCount = revertLog.split('\n').filter((s) => s.trim().length > 0).length;
  } catch {
    // Soft-fail revert detection: a working role-commit count plus zero
    // reverts is still useful, just an under-count rather than a hard error.
    revertCount = 0;
  }

  const ratio = roleCount > 0 ? revertCount / roleCount : null;
  return {
    role_commits: roleCount,
    revert_commits: revertCount,
    revert_ratio: ratio,
    git_unavailable: false,
    window_days: REVERT_WINDOW_DAYS,
  };
}

/**
 * Bucket a flat list of date tokens into N consecutive 7-day windows ending
 * at `now`. The last bucket is "the past 7 days"; the first bucket is the
 * earliest in the window. Each bucket's `end_date` is the ISO date its
 * window ends on, and `label` is a short "MMM D" string for the table.
 *
 * Dates that fail to parse or fall outside the window are dropped — they
 * still inflate the total counts on the parent panel, but they don't
 * distort the weekly view.
 */
export function bucketByWeek(
  dates: (string | null | undefined)[],
  now: number,
  buckets: number,
): WeeklyBucket[] {
  const out: WeeklyBucket[] = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const endMs = now - i * 7 * MS_PER_DAY;
    const startMs = endMs - 7 * MS_PER_DAY;
    let count = 0;
    for (const d of dates) {
      if (!d) continue;
      const t = Date.parse(d);
      if (!Number.isFinite(t)) continue;
      if (t > startMs && t <= endMs) count += 1;
    }
    const endDate = new Date(endMs);
    out.push({
      end_date: endDate.toISOString().slice(0, 10),
      label: formatShortDate(endDate),
      count,
    });
  }
  return out;
}

function formatShortDate(d: Date): string {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  if (a === undefined || b === undefined) return null;
  return (a + b) / 2;
}

/**
 * Scan an escalation body for the most recent `## Operator note · <iso>`
 * heading and return the timestamp. Operator notes are appended by triage
 * actions (accept/decline/comment) and carry a local-ISO timestamp on the
 * heading; we use that as the triage timestamp for time-to-triage math.
 * Returns `null` when no operator note is present (the escalation is open).
 */
export function extractOperatorNoteTimestamp(body: string): string | null {
  if (!body) return null;
  // Local-ISO shape: `YYYY-MM-DDTHH:MM:SS±HH:MM` — that's what
  // `localIsoString` in triage emits (a local time with a numeric tz offset).
  // We also accept the bare `…HH:MM` and Z-suffixed UTC for forward compat,
  // since older entries / external editors might write either.
  const re =
    /^##\s+Operator note\s+·\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/gm;
  let latest: number = Number.NEGATIVE_INFINITY;
  let latestRaw: string | null = null;
  for (const m of body.matchAll(re)) {
    const raw = m[1] ?? '';
    if (raw.length === 0) continue;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) continue;
    if (t > latest) {
      latest = t;
      latestRaw = raw;
    }
  }
  return latestRaw;
}
