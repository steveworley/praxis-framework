import { describe, expect, it } from 'vitest';

import type { ActivityEntry } from './activity-loader.ts';
import type { EscalationEntry } from './escalations-loader.ts';
import type { MemoryEntry } from './memory-loader.ts';
import {
  bucketByDay,
  daysSince,
  isStale,
  recentActivityBreakdown,
  recentActivityCount,
  recentMemoryBreakdown,
  recentMemoryCount,
} from './recent-stats.ts';

const NOW = Date.parse('2026-05-05T12:00:00Z');

function escalation(overrides: Partial<EscalationEntry>): EscalationEntry {
  return {
    slug: 'x',
    path: 'escalations/x.md',
    title: 'x',
    kind: 'help',
    urgency: 'normal',
    status: 'open',
    created: null,
    agent_context: null,
    proposed_skill_path: null,
    proposed_skill_body: null,
    criterion: null,
    trend: null,
    runs: null,
    body: '',
    ...overrides,
  };
}

describe('daysSince', () => {
  it('returns whole-day delta', () => {
    expect(daysSince('2026-04-30', NOW)).toBe(5);
  });

  it('handles ISO timestamps', () => {
    expect(daysSince('2026-05-04T10:00:00Z', NOW)).toBe(1);
  });

  it('returns null for missing or unparseable inputs', () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince(undefined, NOW)).toBeNull();
    expect(daysSince('not-a-date', NOW)).toBeNull();
  });
});

describe('isStale', () => {
  it('flags open escalations older than 7 days', () => {
    expect(isStale(escalation({ status: 'open', created: '2026-04-25' }), NOW)).toBe(true);
  });

  it('does not flag escalations within 7 days', () => {
    expect(isStale(escalation({ status: 'open', created: '2026-04-30' }), NOW)).toBe(false);
  });

  it('does not flag resolved escalations', () => {
    expect(isStale(escalation({ status: 'resolved', created: '2026-04-01' }), NOW)).toBe(false);
  });

  it('does not flag entries with no created date', () => {
    expect(isStale(escalation({ status: 'open', created: null }), NOW)).toBe(false);
  });
});

describe('bucketByDay', () => {
  it('groups entries by calendar day, preserving order', () => {
    const entries: ActivityEntry[] = [
      { _log_path: 'a', timestamp: '2026-05-05T08:00:00Z', action: 'intake' },
      { _log_path: 'a', timestamp: '2026-05-05T10:00:00Z', action: 'sent' },
      { _log_path: 'b', timestamp: '2026-05-04T12:00:00Z', action: 'memory' },
    ];
    const buckets = bucketByDay(entries);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.day).toBe('2026-05-05');
    expect(buckets[0]?.items).toHaveLength(2);
    expect(buckets[1]?.day).toBe('2026-05-04');
  });

  it('handles missing timestamps as "unknown"', () => {
    const entries: ActivityEntry[] = [{ _log_path: 'a' }];
    expect(bucketByDay(entries)[0]?.day).toBe('unknown');
  });
});

describe('recentMemoryCount', () => {
  const memos: MemoryEntry[] = [
    {
      category: 'people',
      slug: 'a',
      path: 'memory/people/a.md',
      title: 'A',
      created: '2026-04-30',
      updated: '2026-05-04',
      body: '',
      frontmatter: {},
      archived: false,
    },
    {
      category: 'notes',
      slug: 'b',
      path: 'memory/notes/b.md',
      title: 'B',
      created: '2026-04-15',
      updated: '2026-04-15',
      body: '',
      frontmatter: {},
      archived: false,
    },
  ];

  it('counts entries inside the window', () => {
    expect(recentMemoryCount(memos, 7, NOW)).toBe(1);
  });

  it('counts breakdown by category', () => {
    expect(recentMemoryBreakdown(memos, 30, NOW)).toEqual({ people: 1, notes: 1 });
  });
});

describe('recentActivityCount + breakdown', () => {
  const acts: ActivityEntry[] = [
    { _log_path: 'a', timestamp: '2026-05-05T08:00:00Z', action: 'intake' },
    { _log_path: 'a', timestamp: '2026-05-05T10:00:00Z', action: 'intake' },
    { _log_path: 'a', timestamp: '2026-05-04T08:00:00Z', action: 'sent' },
    { _log_path: 'b', timestamp: '2026-04-01T08:00:00Z', action: 'sent' },
  ];

  it('counts entries from today (calendar day)', () => {
    expect(recentActivityCount(acts, 1, NOW)).toBe(2);
  });

  it('counts entries across multiple calendar days', () => {
    expect(recentActivityCount(acts, 2, NOW)).toBe(3);
  });

  it('builds today-only action breakdown', () => {
    expect(recentActivityBreakdown(acts, 1, NOW)).toEqual({ intake: 2 });
  });

  it('builds multi-day action breakdown', () => {
    expect(recentActivityBreakdown(acts, 2, NOW)).toEqual({ intake: 2, sent: 1 });
  });
});
