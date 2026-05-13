/**
 * Server-side formatters for ISO timestamps. The dashboard's pages render
 * timestamps in two shapes:
 *
 *   - `formatIsoDate('2026-01-12T09:14:00Z')` → `'2026-01-12'` (the date band
 *     on /role's recent-edits feed and similar surfaces).
 *   - `formatIsoTime('2026-01-12T09:14:00Z')` → `'09:14'` (24-hour, used
 *     inside a day's bucket on /activity).
 *
 * Both fall back to a sliced fragment of the source string when the value
 * doesn't parse — the dashboard always prefers a literal token over a blank.
 */

export function formatIsoDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function formatIsoTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return d.toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Days elapsed between an ISO date/datetime token and `now`. Returns `null`
 * when the input is empty, unparseable, or in the future (a future-dated
 * entry would otherwise show as a negative age, which the UI has no sensible
 * way to render). Rounds down to whole days.
 */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Render a day count as a coarse "<n><unit> ago" label, e.g. `1d ago`,
 * `3w ago`, `2mo ago`, `1y ago`. Buckets follow the dashboard's other
 * coarse-time surfaces: under a week → days; under ~9 weeks → weeks;
 * under a year → months (30-day approximation); otherwise years.
 *
 * Returns `'today'` for `days === 0` and `''` for `null` (the call site
 * usually wants to omit the age line entirely when the source is missing).
 */
export function formatAgeLabel(days: number | null): string {
  if (days === null) return '';
  if (days <= 0) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
