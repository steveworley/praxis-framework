import type { ActivityEntry } from './activity-loader.ts';
import type { EscalationEntry } from './escalations-loader.ts';
import type { MemoryEntry } from './memory-loader.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 7;

/**
 * Whole-day delta between an ISO date string (YYYY-MM-DD or any parseable ISO
 * timestamp) and `now`. Returns null if the input is missing or unparseable
 * so callers can decide how to treat absent data.
 */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((now - parsed) / MS_PER_DAY);
}

/**
 * An escalation is considered stale when it's still open and its created
 * date is older than the threshold (default 7 days). Missing created dates
 * are not stale — we don't penalise entries we can't measure.
 */
export function isStale(escalation: EscalationEntry, now: number = Date.now()): boolean {
  if (escalation.status !== 'open') return false;
  const days = daysSince(escalation.created, now);
  if (days === null) return false;
  return days > STALE_THRESHOLD_DAYS;
}

export interface DayBucket<T> {
  day: string;
  label: string;
  items: T[];
}

/**
 * Bucket activity entries by their YYYY-MM-DD calendar day, preserving entry
 * order within each bucket. The label is a localised "Mon, 5 May" form.
 */
export function bucketByDay(entries: ActivityEntry[]): DayBucket<ActivityEntry>[] {
  const buckets: DayBucket<ActivityEntry>[] = [];
  let current: DayBucket<ActivityEntry> | null = null;
  for (const entry of entries) {
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    const day = ts.slice(0, 10) || 'unknown';
    if (!current || current.day !== day) {
      current = { day, label: dayLabel(ts), items: [] };
      buckets.push(current);
    }
    current.items.push(entry);
  }
  return buckets;
}

function dayLabel(ts: string): string {
  if (!ts) return 'unknown';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
    return d.toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return ts.slice(0, 10);
  }
}

/**
 * Count memory entries updated within the last `days` days. Entries with no
 * `updated` value are counted only if the fallback `created` is recent.
 */
export function recentMemoryCount(entries: MemoryEntry[], days: number, now: number = Date.now()): number {
  const cutoff = now - days * MS_PER_DAY;
  let n = 0;
  for (const e of entries) {
    const ref = e.updated ?? e.created;
    if (!ref) continue;
    const parsed = Date.parse(ref);
    if (Number.isNaN(parsed)) continue;
    if (parsed >= cutoff) n += 1;
  }
  return n;
}

/**
 * Count activity entries logged within the last `days` calendar days.
 * `days = 1` means "today only" — entries whose YYYY-MM-DD matches today.
 * `days = 7` means "today and the previous six days". Calendar semantics
 * matter on the home page where "Activity (today)" is shown.
 */
export function recentActivityCount(entries: ActivityEntry[], days: number, now: number = Date.now()): number {
  const cutoff = calendarCutoff(now, days);
  let n = 0;
  for (const e of entries) {
    if (typeof e.timestamp !== 'string') continue;
    const parsed = Date.parse(e.timestamp);
    if (Number.isNaN(parsed)) continue;
    if (parsed >= cutoff) n += 1;
  }
  return n;
}

function calendarCutoff(now: number, days: number): number {
  const d = new Date(now);
  // Start of "today" in UTC, then step back days-1 calendar days.
  const startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return startOfToday - Math.max(0, days - 1) * MS_PER_DAY;
}

/**
 * Tally memory entries by category for entries within the last `days` days.
 * Returned shape is `{ category: count }` with categories sorted alphabetically.
 */
export function recentMemoryBreakdown(
  entries: MemoryEntry[],
  days: number,
  now: number = Date.now(),
): Record<string, number> {
  const cutoff = now - days * MS_PER_DAY;
  const out: Record<string, number> = {};
  for (const e of entries) {
    const ref = e.updated ?? e.created;
    if (!ref) continue;
    const parsed = Date.parse(ref);
    if (Number.isNaN(parsed)) continue;
    if (parsed < cutoff) continue;
    out[e.category] = (out[e.category] ?? 0) + 1;
  }
  return out;
}

/**
 * Tally activity entries by `action` for entries within the last `days`
 * calendar days. Used to populate the home page's "Activity (today)" breakdown.
 */
export function recentActivityBreakdown(
  entries: ActivityEntry[],
  days: number,
  now: number = Date.now(),
): Record<string, number> {
  const cutoff = calendarCutoff(now, days);
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (typeof e.timestamp !== 'string') continue;
    const parsed = Date.parse(e.timestamp);
    if (Number.isNaN(parsed)) continue;
    if (parsed < cutoff) continue;
    const action = typeof e.action === 'string' && e.action.length > 0 ? e.action : 'other';
    out[action] = (out[action] ?? 0) + 1;
  }
  return out;
}
