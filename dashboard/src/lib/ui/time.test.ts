import { describe, expect, it } from 'vitest';

import { daysSince, formatAgeLabel, formatIsoDate, formatIsoTime } from './time.js';

describe('formatIsoDate', () => {
  it('returns ISO YYYY-MM-DD for a valid timestamp', () => {
    expect(formatIsoDate('2026-01-12T09:14:00Z')).toBe('2026-01-12');
  });

  it('returns an empty string for empty input', () => {
    expect(formatIsoDate('')).toBe('');
  });

  it('falls back to the first 10 chars when the value does not parse', () => {
    // `not-a-date` is invalid; slice(0,10) yields `not-a-date`.
    expect(formatIsoDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatIsoTime', () => {
  it('returns HH:MM in 24-hour format for a valid timestamp', () => {
    // Astro renders this server-side in en-AU locale, 24h. We pin to a
    // value that lands cleanly inside a single hour regardless of TZ —
    // checking the regex shape is enough for our purpose.
    const out = formatIsoTime('2026-01-12T09:14:00Z');
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns an empty string for undefined input', () => {
    expect(formatIsoTime(undefined)).toBe('');
  });

  it('returns an empty string for an empty string', () => {
    expect(formatIsoTime('')).toBe('');
  });

  it('falls back to a sliced fragment when the value does not parse', () => {
    // `not-a-real-tslit` → slice(11,16) yields `tsli` (4 chars after 11).
    // Verify the fallback is the .slice(11,16) shape (could be any).
    expect(formatIsoTime('abcdefghijklmnopq')).toBe('lmnop');
  });
});

describe('daysSince', () => {
  const now = new Date('2026-05-13T12:00:00Z');

  it('returns null for empty / null / undefined', () => {
    expect(daysSince('', now)).toBeNull();
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince(undefined, now)).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(daysSince('not-a-date', now)).toBeNull();
  });

  it('returns null for future dates', () => {
    expect(daysSince('2026-06-01', now)).toBeNull();
  });

  it('returns 0 for today (rounded down)', () => {
    expect(daysSince('2026-05-13', now)).toBe(0);
  });

  it('counts whole days between dates', () => {
    expect(daysSince('2026-05-06', now)).toBe(7);
    expect(daysSince('2026-04-13', now)).toBe(30);
  });
});

describe('formatAgeLabel', () => {
  it('returns an empty string for null', () => {
    expect(formatAgeLabel(null)).toBe('');
  });

  it('returns "today" for 0', () => {
    expect(formatAgeLabel(0)).toBe('today');
  });

  it('renders days for under-a-week ages', () => {
    expect(formatAgeLabel(1)).toBe('1d ago');
    expect(formatAgeLabel(6)).toBe('6d ago');
  });

  it('renders weeks for week-to-month-ish ages', () => {
    expect(formatAgeLabel(7)).toBe('1w ago');
    expect(formatAgeLabel(21)).toBe('3w ago');
    expect(formatAgeLabel(59)).toBe('8w ago');
  });

  it('renders months for month-to-year ages', () => {
    expect(formatAgeLabel(60)).toBe('2mo ago');
    expect(formatAgeLabel(364)).toBe('12mo ago');
  });

  it('renders years for year-plus ages', () => {
    expect(formatAgeLabel(365)).toBe('1y ago');
    expect(formatAgeLabel(800)).toBe('2y ago');
  });
});
