/**
 * Local-time string helpers shared across the chat surface.
 *
 * The JSONL audit log, decision log, archive markers, and output tool
 * frontmatter all want the same `YYYY-MM-DD` date and the same
 * `YYYY-MM-DDTHH:MM:SS±HH:MM` timestamp shape (matching `praxis log`'s wire
 * format). We hoist the two helpers into a single module so callers stop
 * re-implementing them in parallel — and so that the activity emitter can
 * use the exact same shape `executeLogDecision` writes.
 */

/**
 * Local-zone date string in `YYYY-MM-DD` form. Used to address the daily
 * JSONL log file (`logs/<date>.jsonl`) and to stamp `created` / `updated`
 * frontmatter dates on memory entries.
 */
export function localDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Local-zone ISO-8601 timestamp with numeric timezone offset (matches
 * `praxis log` JSONL output). Used as the `timestamp` field on every
 * activity-log entry so the `/activity` page can sort entries chronologically
 * regardless of the role's host timezone.
 */
export function localIsoString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offHh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offMm = String(absOffset % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${offHh}:${offMm}`;
}
