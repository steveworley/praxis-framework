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
