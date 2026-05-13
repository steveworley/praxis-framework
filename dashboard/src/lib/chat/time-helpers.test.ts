import { describe, expect, it } from 'vitest';

import { localDateString, localIsoString } from './time-helpers.ts';

describe('localDateString', () => {
  it('renders YYYY-MM-DD in the local zone with zero padding', () => {
    const d = new Date(2026, 0, 5, 10, 0, 0); // Jan 5 local
    expect(localDateString(d)).toBe('2026-01-05');
  });
});

describe('localIsoString', () => {
  it('emits a local timestamp with a numeric tz offset', () => {
    const d = new Date(2026, 4, 12, 9, 30, 15); // 09:30:15 local
    const out = localIsoString(d);
    // Shape: YYYY-MM-DDTHH:MM:SS±HH:MM
    expect(out).toMatch(/^2026-05-12T09:30:15[+-]\d{2}:\d{2}$/);
  });
});
