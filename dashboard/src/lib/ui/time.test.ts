import { describe, expect, it } from 'vitest';

import { formatIsoDate, formatIsoTime } from './time.js';

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
