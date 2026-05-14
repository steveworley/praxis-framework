import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCriteriaHealth,
  bucketByWeek,
  extractOperatorNoteTimestamp,
  loadHealth,
} from './health-loader.ts';
import type { MemoryEntry } from './memory-loader.ts';

let tempDir: string;

// Pinned "now" used across the suite. May 13, 2026 — same as the dashboard's
// test fixtures elsewhere — lets us write date tokens by hand and predict
// which weekly bucket they land in without timezone surprises.
const NOW_ISO = '2026-05-13T12:00:00Z';
const NOW_MS = Date.parse(NOW_ISO);

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-health-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('bucketByWeek', () => {
  it('produces N buckets ending at `now`, oldest first', () => {
    const buckets = bucketByWeek([], NOW_MS, 4);
    expect(buckets).toHaveLength(4);
    // The last bucket ends on the now-date itself.
    expect(buckets[3]?.end_date).toBe('2026-05-13');
    // Earlier buckets step back 7 days at a time.
    expect(buckets[2]?.end_date).toBe('2026-05-06');
    expect(buckets[1]?.end_date).toBe('2026-04-29');
    expect(buckets[0]?.end_date).toBe('2026-04-22');
  });

  it('drops dates outside the window', () => {
    const buckets = bucketByWeek(
      ['2026-05-10', '2026-01-01', null, undefined, 'nonsense', '2027-01-01'],
      NOW_MS,
      4,
    );
    const total = buckets.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(1);
    expect(buckets[3]?.count).toBe(1);
  });

  it('counts each date in exactly one bucket (window boundaries are right-inclusive)', () => {
    // 2026-05-06 sits on the boundary between bucket[2] and bucket[3]. The
    // implementation treats each bucket as (start, end] so the boundary
    // counts toward the *earlier* bucket — that keeps day-overlaps from
    // double-counting.
    const buckets = bucketByWeek(['2026-05-06T00:00:00Z'], NOW_MS, 4);
    expect(buckets[2]?.count).toBe(1);
    expect(buckets[3]?.count).toBe(0);
  });
});

describe('loadHealth — memory aggregations', () => {
  it('buckets memory entries by week and sorts categories desc by count', async () => {
    const mem = path.join(tempDir, 'memory');
    await fs.mkdir(path.join(mem, 'people'), { recursive: true });
    await fs.mkdir(path.join(mem, 'notes'), { recursive: true });
    // This-week (2026-05-13) entries.
    await fs.writeFile(
      path.join(mem, 'people', 'a.md'),
      '---\nupdated: 2026-05-12\n---\n# A',
      'utf-8',
    );
    await fs.writeFile(
      path.join(mem, 'people', 'b.md'),
      '---\nupdated: 2026-05-10\n---\n# B',
      'utf-8',
    );
    // Last week.
    await fs.writeFile(
      path.join(mem, 'people', 'c.md'),
      '---\nupdated: 2026-05-05\n---\n# C',
      'utf-8',
    );
    // Older — outside window.
    await fs.writeFile(
      path.join(mem, 'notes', 'old.md'),
      '---\nupdated: 2026-01-01\n---\n# Old',
      'utf-8',
    );

    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.memory.total).toBe(4);
    expect(report.memory.weekly).toHaveLength(4);
    // 2026-05-12 and 2026-05-10 land in the final bucket; 2026-05-05 in the
    // bucket before that; the January entry falls outside the window.
    expect(report.memory.weekly[3]?.count).toBe(2);
    expect(report.memory.weekly[2]?.count).toBe(1);
    expect(report.memory.weekly[0]?.count).toBe(0);
    // Categories sorted by count desc, then alphabetically.
    expect(report.memory.by_category).toEqual([
      { category: 'people', count: 3 },
      { category: 'notes', count: 1 },
    ]);
    expect(report.memory.last_update).toBe('2026-05-12');
  });

  it('returns an empty memory section when memory/ is missing', async () => {
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.memory.total).toBe(0);
    expect(report.memory.weekly).toHaveLength(4);
    expect(report.memory.weekly.every((b) => b.count === 0)).toBe(true);
    expect(report.memory.by_category).toEqual([]);
    expect(report.memory.last_update).toBeNull();
  });
});

describe('loadHealth — escalation status counts', () => {
  it('counts open / resolved / accepted / declined separately', async () => {
    const dir = path.join(tempDir, 'escalations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, '2026-05-01-a.md'),
      '---\nkind: help\ncreated: 2026-05-01\nstatus: open\n---\n# A',
      'utf-8',
    );
    await fs.writeFile(
      path.join(dir, '2026-05-02-b.md'),
      '---\nkind: help\ncreated: 2026-05-02\nstatus: resolved\n---\n# B',
      'utf-8',
    );
    await fs.writeFile(
      path.join(dir, '2026-05-03-c.md'),
      '---\nkind: help\ncreated: 2026-05-03\nstatus: accepted\n---\n# C',
      'utf-8',
    );
    await fs.writeFile(
      path.join(dir, '2026-05-04-d.md'),
      '---\nkind: improvement\ncreated: 2026-05-04\nstatus: declined\n---\n# D',
      'utf-8',
    );

    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.escalations.counts_by_status).toEqual({
      open: 1,
      resolved: 1,
      accepted: 1,
      declined: 1,
    });
    expect(report.escalations.total).toBe(4);
    // Each non-open escalation contributes to its respective resolved/declined
    // weekly histogram.
    const resolvedTotal = report.escalations.weekly_resolved.reduce((a, b) => a + b.count, 0);
    const declinedTotal = report.escalations.weekly_declined.reduce((a, b) => a + b.count, 0);
    expect(resolvedTotal).toBe(2); // resolved + accepted
    expect(declinedTotal).toBe(1);
  });

  it('computes median time-to-triage from operator-note timestamps', async () => {
    const dir = path.join(tempDir, 'escalations');
    await fs.mkdir(dir, { recursive: true });
    // Filed May 1, triaged May 4 (delta = 3 days).
    await fs.writeFile(
      path.join(dir, '2026-05-01-a.md'),
      [
        '---',
        'kind: help',
        'created: 2026-05-01T00:00:00Z',
        'status: accepted',
        '---',
        '# A',
        '',
        '## Operator note · 2026-05-04T00:00:00Z · accepted',
        '',
        'ok',
      ].join('\n'),
      'utf-8',
    );
    // Filed May 5, triaged May 6 (delta = 1 day).
    await fs.writeFile(
      path.join(dir, '2026-05-05-b.md'),
      [
        '---',
        'kind: help',
        'created: 2026-05-05T00:00:00Z',
        'status: resolved',
        '---',
        '# B',
        '',
        '## Operator note · 2026-05-06T00:00:00Z · accepted',
        '',
        'ok',
      ].join('\n'),
      'utf-8',
    );

    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.escalations.triage_sample_size).toBe(2);
    expect(report.escalations.median_time_to_triage_days).toBe(2);
  });
});

describe('loadHealth — tool-call distribution', () => {
  it('counts entries by action over the 30-day window, sorted desc', async () => {
    const logsDir = path.join(tempDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    // Three write_memory, two propose_verb, one log_decision — within window.
    const within: string[] = [
      `{"timestamp":"2026-05-10T01:00:00Z","action":"write_memory"}`,
      `{"timestamp":"2026-05-09T01:00:00Z","action":"write_memory"}`,
      `{"timestamp":"2026-05-08T01:00:00Z","action":"write_memory"}`,
      `{"timestamp":"2026-05-07T01:00:00Z","action":"propose_verb"}`,
      `{"timestamp":"2026-05-06T01:00:00Z","action":"propose_verb"}`,
      `{"timestamp":"2026-05-05T01:00:00Z","action":"log_decision"}`,
      // Outside the 30-day window — should not be counted.
      `{"timestamp":"2026-01-01T01:00:00Z","action":"write_memory"}`,
      // Missing action — dropped.
      `{"timestamp":"2026-05-04T01:00:00Z"}`,
    ];
    await fs.writeFile(path.join(logsDir, '2026-05-10.jsonl'), within.join('\n'), 'utf-8');

    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.activity.total).toBe(6);
    expect(report.activity.by_tool).toEqual([
      { tool: 'write_memory', count: 3 },
      { tool: 'propose_verb', count: 2 },
      { tool: 'log_decision', count: 1 },
    ]);
  });

  it('returns an empty distribution when no logs are present', async () => {
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.activity.total).toBe(0);
    expect(report.activity.by_tool).toEqual([]);
  });
});

describe('loadHealth — autonomy / revert ratio', () => {
  async function initRepo(dir: string): Promise<void> {
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.email', 'host@example.test', false, 'local');
    await git.addConfig('user.name', 'Host User', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
  }

  async function commitAs(
    dir: string,
    file: string,
    body: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<void> {
    const full = path.join(dir, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf-8');
    const git = simpleGit(dir);
    await git.add(file);
    await git.raw(['commit', `--author=${author.name} <${author.email}>`, '-m', message]);
  }

  it('flags git_unavailable when the role home is not a git repo', async () => {
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.git_unavailable).toBe(true);
    expect(report.autonomy.role_commits).toBe(0);
    expect(report.autonomy.revert_commits).toBe(0);
    expect(report.autonomy.revert_ratio).toBeNull();
  });

  it('returns 0/0 with a null ratio when there are no role commits', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'README.md', 'r', 'chore: seed', {
      name: 'Host',
      email: 'host@example.test',
    });
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.git_unavailable).toBe(false);
    expect(report.autonomy.role_commits).toBe(0);
    expect(report.autonomy.revert_commits).toBe(0);
    expect(report.autonomy.revert_ratio).toBeNull();
  });

  it('counts a single role commit, ratio 0 when no reverts exist', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'memory/a.md', '# A', 'role(memory): note alice', {
      name: 'Praxis Role',
      email: 'role@praxis.local',
    });
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.role_commits).toBe(1);
    expect(report.autonomy.revert_commits).toBe(0);
    expect(report.autonomy.revert_ratio).toBe(0);
  });

  it('detects a Revert "role(...)" commit and computes ratio 1.0', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'memory/a.md', '# A', 'role(memory): note alice', {
      name: 'Praxis Role',
      email: 'role@praxis.local',
    });
    await commitAs(tempDir, 'memory/b.md', '# B', 'Revert "role(memory): note alice"', {
      name: 'Host User',
      email: 'host@example.test',
    });
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.role_commits).toBe(1);
    expect(report.autonomy.revert_commits).toBe(1);
    expect(report.autonomy.revert_ratio).toBe(1);
  });

  it('handles a mixed history: two role commits, one revert → ratio 0.5', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'memory/a.md', '# A', 'role(memory): note alice', {
      name: 'Praxis Role',
      email: 'role@praxis.local',
    });
    await commitAs(tempDir, 'memory/b.md', '# B', 'role(memory): note bob', {
      name: 'Praxis Role',
      email: 'role@praxis.local',
    });
    await commitAs(tempDir, 'README.md', 'r', 'Revert "role(memory): note alice"', {
      name: 'Host User',
      email: 'host@example.test',
    });
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.role_commits).toBe(2);
    expect(report.autonomy.revert_commits).toBe(1);
    expect(report.autonomy.revert_ratio).toBe(0.5);
  });

  it('ignores reverts of non-role commits', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'memory/a.md', '# A', 'role(memory): note alice', {
      name: 'Praxis Role',
      email: 'role@praxis.local',
    });
    await commitAs(tempDir, 'README.md', 'r', 'Revert "feat(dashboard): something"', {
      name: 'Host User',
      email: 'host@example.test',
    });
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.autonomy.role_commits).toBe(1);
    expect(report.autonomy.revert_commits).toBe(0);
    expect(report.autonomy.revert_ratio).toBe(0);
  });
});

describe('buildCriteriaHealth', () => {
  function entry(title: string, body: string, updated: string): MemoryEntry {
    return {
      category: 'notes',
      slug: title.toLowerCase().replace(/\s+/g, '-'),
      path: `memory/notes/${title}.md`,
      title,
      created: updated,
      updated,
      body,
      frontmatter: {},
      archived: false,
    };
  }

  it('returns one row per declared criterion in declaration order', () => {
    const out = buildCriteriaHealth(['Crit A', 'Crit B', 'Crit C'], []);
    expect(out.criteria.map((c) => c.criterion)).toEqual(['Crit A', 'Crit B', 'Crit C']);
    expect(out.criteria.every((c) => c.latest === null)).toBe(true);
    expect(out.criteria.every((c) => c.trend.length === 0)).toBe(true);
  });

  it('surfaces the most recent assessment for each criterion', () => {
    const entries: MemoryEntry[] = [
      entry(
        'Criteria self-assessment 2026-05-12',
        ['## Crit A', '**Status**: amber', '**Reasoning**: drifting'].join('\n'),
        '2026-05-12',
      ),
      entry(
        'Criteria self-assessment 2026-05-05',
        ['## Crit A', '**Status**: green', '**Reasoning**: ok'].join('\n'),
        '2026-05-05',
      ),
    ];
    const out = buildCriteriaHealth(['Crit A', 'Crit B'], entries);
    expect(out.criteria[0]?.latest?.status).toBe('amber');
    expect(out.criteria[0]?.latest?.reasoning).toBe('drifting');
    // Trend oldest → newest.
    expect(out.criteria[0]?.trend).toEqual(['green', 'amber']);
    // Crit B has no assessment yet.
    expect(out.criteria[1]?.latest).toBeNull();
    expect(out.criteria[1]?.trend).toEqual([]);
  });

  it('caps the trend at trendLength (defaults to 4)', () => {
    const entries: MemoryEntry[] = [
      entry(
        'Criteria self-assessment 2026-05-12',
        ['## Crit A', '**Status**: red', '**Reasoning**: ...'].join('\n'),
        '2026-05-12',
      ),
      entry(
        'Criteria self-assessment 2026-05-05',
        ['## Crit A', '**Status**: amber', '**Reasoning**: ...'].join('\n'),
        '2026-05-05',
      ),
      entry(
        'Criteria self-assessment 2026-04-28',
        ['## Crit A', '**Status**: amber', '**Reasoning**: ...'].join('\n'),
        '2026-04-28',
      ),
      entry(
        'Criteria self-assessment 2026-04-21',
        ['## Crit A', '**Status**: green', '**Reasoning**: ...'].join('\n'),
        '2026-04-21',
      ),
      entry(
        'Criteria self-assessment 2026-04-14',
        ['## Crit A', '**Status**: green', '**Reasoning**: ...'].join('\n'),
        '2026-04-14',
      ),
    ];
    const out = buildCriteriaHealth(['Crit A'], entries);
    expect(out.trend_length).toBe(4);
    // Most recent 4, oldest → newest.
    expect(out.criteria[0]?.trend).toEqual(['green', 'amber', 'amber', 'red']);
  });

  it('honours a custom trendLength', () => {
    const entries: MemoryEntry[] = [
      entry(
        'Criteria self-assessment 2026-05-12',
        ['## Crit A', '**Status**: red', '**Reasoning**: ...'].join('\n'),
        '2026-05-12',
      ),
      entry(
        'Criteria self-assessment 2026-05-05',
        ['## Crit A', '**Status**: green', '**Reasoning**: ...'].join('\n'),
        '2026-05-05',
      ),
    ];
    const out = buildCriteriaHealth(['Crit A'], entries, 1);
    expect(out.criteria[0]?.trend).toEqual(['red']);
  });

  it('returns empty criteria array when persona declares none', () => {
    const out = buildCriteriaHealth([], []);
    expect(out.criteria).toEqual([]);
  });
});

describe('loadHealth — criteria aggregation', () => {
  it('joins declared criteria to self-assessment memory entries', async () => {
    // Persona with 3 declared criteria.
    await fs.writeFile(
      path.join(tempDir, 'persona.md'),
      [
        '# Persona',
        '',
        '## Success criteria',
        '',
        '- Drafts land in ≤2 review cycles',
        '- Weekly account reads surface ≥1 actionable signal',
        '- No opted-out prospect is ever re-touched',
      ].join('\n'),
      'utf-8',
    );
    // Memory with 1 assessment covering 2 of the 3 criteria.
    const mem = path.join(tempDir, 'memory', 'self-assessment');
    await fs.mkdir(mem, { recursive: true });
    await fs.writeFile(
      path.join(mem, 'assessment-2026-05-12.md'),
      [
        '---',
        'title: Criteria self-assessment 2026-05-12',
        'created: 2026-05-12',
        'updated: 2026-05-12',
        '---',
        '',
        '# Criteria self-assessment 2026-05-12',
        '',
        '## Drafts land in ≤2 review cycles',
        '',
        '**Status**: amber',
        '**Reasoning**: Last 8 drafts averaged 2.4 cycles.',
        '',
        '## Weekly account reads surface ≥1 actionable signal',
        '',
        '**Status**: green',
        '**Reasoning**: 7 signals across 5 reads.',
      ].join('\n'),
      'utf-8',
    );

    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.criteria.criteria).toHaveLength(3);
    expect(report.criteria.criteria[0]?.latest?.status).toBe('amber');
    expect(report.criteria.criteria[1]?.latest?.status).toBe('green');
    // Third criterion has no assessment yet.
    expect(report.criteria.criteria[2]?.latest).toBeNull();
  });

  it('returns an empty criteria list when persona declares none', async () => {
    const report = await loadHealth(tempDir, NOW_MS);
    expect(report.criteria.criteria).toEqual([]);
  });
});

describe('extractOperatorNoteTimestamp', () => {
  it('returns null when no operator note is present', () => {
    expect(extractOperatorNoteTimestamp('# nothing here')).toBeNull();
    expect(extractOperatorNoteTimestamp('')).toBeNull();
  });

  it('returns the most-recent operator-note timestamp', () => {
    const body = [
      '# Escalation',
      '',
      '## Operator note · 2026-05-01T12:00:00Z · comment',
      'first',
      '',
      '## Operator note · 2026-05-03T12:00:00Z · accepted',
      'second',
    ].join('\n');
    expect(extractOperatorNoteTimestamp(body)).toBe('2026-05-03T12:00:00Z');
  });

  it('parses the local-ISO offset shape that triage emits', () => {
    const body = '## Operator note · 2026-05-03T22:00:00+10:00 · accepted\n';
    expect(extractOperatorNoteTimestamp(body)).toBe('2026-05-03T22:00:00+10:00');
  });
});
