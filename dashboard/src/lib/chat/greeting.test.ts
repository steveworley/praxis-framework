import { describe, expect, it } from 'vitest';

import { bucketFromHour, buildGreeting } from './greeting';

describe('bucketFromHour', () => {
  // The brief: morning < 12, afternoon < 17, evening < 21, night otherwise.
  // 0–11 round into "morning" — the dashboard doesn't ship a 0–5 "wee hours"
  // bucket because the role won't typically be greeted in that window.
  it('buckets standard hours', () => {
    expect(bucketFromHour(0)).toBe('morning');
    expect(bucketFromHour(8)).toBe('morning');
    expect(bucketFromHour(11)).toBe('morning');
    expect(bucketFromHour(12)).toBe('afternoon');
    expect(bucketFromHour(16)).toBe('afternoon');
    expect(bucketFromHour(17)).toBe('evening');
    expect(bucketFromHour(20)).toBe('evening');
    expect(bucketFromHour(21)).toBe('night');
    expect(bucketFromHour(23)).toBe('night');
  });
});

describe('buildGreeting', () => {
  it('with open escalations: prompts triage with the count spelled out', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 9,
      escalationOpenCount: 2,
      operatorName: 'Steve',
    });
    expect(g.who).toBe('SAM · MORNING · 2 OPEN');
    expect(g.bucket).toBe('morning');
    expect(g.salutation).toBe('Morning, Steve.');
    expect(g.body).toContain('Two escalations are still waiting on you');
    expect(g.body).toContain('{cta}');
    expect(g.ctaText).toBe('triage them');
    expect(g.empty).toBe(false);
  });

  it('singular escalation uses singular grammar', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 14,
      escalationOpenCount: 1,
      operatorName: 'Steve',
    });
    expect(g.body).toContain('One escalation is still waiting on you');
    expect(g.ctaText).toBe('triage it');
    expect(g.salutation).toBe('Afternoon, Steve.');
  });

  it('no escalations: empty-state body, no CTA', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 18,
      escalationOpenCount: 0,
      operatorName: 'Steve',
    });
    expect(g.who).toBe('SAM · EVENING · CLEAR');
    expect(g.salutation).toBe('Evening, Steve.');
    expect(g.body).toBe('Nothing waiting — what should we look at today?');
    expect(g.ctaText).toBe('');
    expect(g.empty).toBe(true);
  });

  it('late-night bucket uses "Working late?" salutation', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 23,
      escalationOpenCount: 1,
      operatorName: 'Steve',
    });
    expect(g.bucket).toBe('night');
    expect(g.salutation).toBe('Working late?, Steve.');
  });

  it('operator name absent: addresses "you" in the salutation', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 9,
      escalationOpenCount: 0,
    });
    expect(g.salutation).toBe('Morning.');
    expect(g.empty).toBe(true);
  });

  it('large counts fall back to numerals', () => {
    const g = buildGreeting({
      personaShort: 'Sam',
      localHour: 9,
      escalationOpenCount: 12,
      operatorName: 'Steve',
    });
    expect(g.body).toContain('12 escalations are still waiting on you');
    expect(g.who).toBe('SAM · MORNING · 12 OPEN');
  });

  it('persona name falls back to "ROLE" when empty', () => {
    const g = buildGreeting({
      personaShort: '',
      localHour: 9,
      escalationOpenCount: 0,
    });
    expect(g.who).toBe('ROLE · MORNING · CLEAR');
  });
});
