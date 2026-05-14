import { describe, expect, it } from 'vitest';

import type { MemoryEntry } from './memory-loader.ts';
import {
  getLatestSelfAssessmentsByCriterion,
  isSelfAssessmentEntry,
  parseSelfAssessment,
} from './self-assessment-parser.ts';

function entry(title: string, body: string, updated = '2026-05-12'): MemoryEntry {
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

describe('parseSelfAssessment', () => {
  it('parses a single criterion with status and reasoning', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      [
        '## Drafts land in ≤2 review cycles',
        '',
        '**Status**: green',
        '**Reasoning**: Last 5 drafts averaged 1.6 cycles.',
      ].join('\n'),
    );
    const out = parseSelfAssessment(e);
    expect(out).toEqual([
      {
        criterion: 'Drafts land in ≤2 review cycles',
        status: 'green',
        reasoning: 'Last 5 drafts averaged 1.6 cycles.',
        assessedAt: '2026-05-12',
      },
    ]);
  });

  it('parses multiple criteria in one entry', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      [
        '## Drafts land in ≤2 review cycles',
        '',
        '**Status**: amber',
        '**Reasoning**: Trending up to 2.4.',
        '',
        '## Weekly reads surface ≥1 actionable signal',
        '',
        '**Status**: green',
        '**Reasoning**: 7 signals filed this week.',
      ].join('\n'),
    );
    const out = parseSelfAssessment(e);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toBe('amber');
    expect(out[1]?.status).toBe('green');
  });

  it('drops sections with no Status line rather than crashing', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      [
        '## Has status',
        '**Status**: green',
        '**Reasoning**: ok',
        '',
        '## Missing status',
        '**Reasoning**: no status here',
      ].join('\n'),
    );
    const out = parseSelfAssessment(e);
    expect(out).toHaveLength(1);
    expect(out[0]?.criterion).toBe('Has status');
  });

  it('drops sections with an unknown status enum', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      [
        '## A',
        '**Status**: maybe',
        '**Reasoning**: invalid status value',
        '',
        '## B',
        '**Status**: red',
        '**Reasoning**: ok',
      ].join('\n'),
    );
    const out = parseSelfAssessment(e);
    expect(out).toHaveLength(1);
    expect(out[0]?.criterion).toBe('B');
  });

  it('tolerates a section with no reasoning line', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      ['## Solo status', '', '**Status**: unsure'].join('\n'),
    );
    const out = parseSelfAssessment(e);
    expect(out).toHaveLength(1);
    expect(out[0]?.reasoning).toBe('');
  });

  it('returns empty for a malformed body with no H2s', () => {
    const e = entry('Criteria self-assessment 2026-05-12', 'Just prose with no headings.');
    expect(parseSelfAssessment(e)).toEqual([]);
  });

  it('returns empty for an empty body', () => {
    const e = entry('Criteria self-assessment 2026-05-12', '');
    expect(parseSelfAssessment(e)).toEqual([]);
  });

  it('preserves the assessedAt date from frontmatter', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      ['## A', '**Status**: green', '**Reasoning**: ok'].join('\n'),
      '2026-05-12',
    );
    expect(parseSelfAssessment(e)[0]?.assessedAt).toBe('2026-05-12');
  });

  it('accepts mixed-case status values (case-insensitive)', () => {
    const e = entry(
      'Criteria self-assessment 2026-05-12',
      ['## A', '**Status**: Amber', '**Reasoning**: ok'].join('\n'),
    );
    expect(parseSelfAssessment(e)[0]?.status).toBe('amber');
  });
});

describe('isSelfAssessmentEntry', () => {
  it('matches the exact title prefix', () => {
    expect(isSelfAssessmentEntry(entry('Criteria self-assessment 2026-05-12', ''))).toBe(true);
  });

  it('does not match other titles', () => {
    expect(isSelfAssessmentEntry(entry('Mary Chen at Acme', ''))).toBe(false);
    expect(isSelfAssessmentEntry(entry('criteria self-assessment 2026-05-12', ''))).toBe(false);
  });
});

describe('getLatestSelfAssessmentsByCriterion', () => {
  it('returns an empty map when no self-assessments are present', () => {
    const out = getLatestSelfAssessmentsByCriterion([entry('Random memo', 'body')]);
    expect(out.size).toBe(0);
  });

  it('aggregates one criterion across multiple entries, newest first', () => {
    const entries: MemoryEntry[] = [
      entry(
        'Criteria self-assessment 2026-05-12',
        ['## Foo', '**Status**: amber', '**Reasoning**: drifting'].join('\n'),
        '2026-05-12',
      ),
      entry(
        'Criteria self-assessment 2026-05-05',
        ['## Foo', '**Status**: green', '**Reasoning**: ok'].join('\n'),
        '2026-05-05',
      ),
      entry(
        'Criteria self-assessment 2026-04-28',
        ['## Foo', '**Status**: green', '**Reasoning**: ok'].join('\n'),
        '2026-04-28',
      ),
    ];
    const out = getLatestSelfAssessmentsByCriterion(entries);
    expect(out.size).toBe(1);
    const foo = out.get('Foo');
    expect(foo).toBeDefined();
    expect(foo).toHaveLength(3);
    // Newest first.
    expect(foo?.[0]?.assessedAt).toBe('2026-05-12');
    expect(foo?.[0]?.status).toBe('amber');
    expect(foo?.[2]?.assessedAt).toBe('2026-04-28');
  });

  it('keys by the H2 text verbatim, not normalised', () => {
    const entries: MemoryEntry[] = [
      entry(
        'Criteria self-assessment 2026-05-12',
        [
          '## Drafts land in ≤2 review cycles',
          '**Status**: green',
          '**Reasoning**: ok',
          '',
          '## Drafts land in <=2 review cycles',
          '**Status**: amber',
          '**Reasoning**: typo-different criterion',
        ].join('\n'),
        '2026-05-12',
      ),
    ];
    const out = getLatestSelfAssessmentsByCriterion(entries);
    expect(out.size).toBe(2);
    expect(out.has('Drafts land in ≤2 review cycles')).toBe(true);
    expect(out.has('Drafts land in <=2 review cycles')).toBe(true);
  });

  it('ignores non-self-assessment entries even if they contain matching markup', () => {
    const entries: MemoryEntry[] = [
      entry('Some note', ['## Foo', '**Status**: green', '**Reasoning**: ok'].join('\n')),
    ];
    const out = getLatestSelfAssessmentsByCriterion(entries);
    expect(out.size).toBe(0);
  });
});
