import { describe, expect, it } from 'vitest';

import type { ActivityEntry } from './activity-loader.ts';
import { isDecisionEntry, toDecisionView } from './decision-renderer.ts';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    _log_path: 'campaigns/x/logs/2026-05-08.jsonl',
    ...overrides,
  };
}

describe('isDecisionEntry', () => {
  it('returns true when action === "decision"', () => {
    expect(isDecisionEntry(entry({ action: 'decision' }))).toBe(true);
  });

  it('returns false for other actions', () => {
    expect(isDecisionEntry(entry({ action: 'intake' }))).toBe(false);
    expect(isDecisionEntry(entry({ action: 'sent' }))).toBe(false);
  });

  it('returns false when action is missing', () => {
    expect(isDecisionEntry(entry({}))).toBe(false);
  });
});

describe('toDecisionView', () => {
  it('projects all fields with classified confidence', () => {
    const view = toDecisionView(
      entry({
        action: 'decision',
        decision_type: 'contact_selection',
        chosen: 'Fiona Rankin (CIO)',
        considered: 'John Wei, Mary Smith',
        rationale: 'Title best matches buyer profile.',
        confidence: 'high',
      }),
    );
    expect(view).toEqual({
      decisionType: 'contact_selection',
      chosen: 'Fiona Rankin (CIO)',
      considered: 'John Wei, Mary Smith',
      rationale: 'Title best matches buyer profile.',
      confidence: 'high',
      confidenceClass: 'high',
    });
  });

  it('collapses missing fields to empty strings', () => {
    const view = toDecisionView(entry({ action: 'decision' }));
    expect(view.decisionType).toBe('');
    expect(view.chosen).toBe('');
    expect(view.considered).toBe('');
    expect(view.rationale).toBe('');
    expect(view.confidence).toBe('');
    expect(view.confidenceClass).toBe('unknown');
  });

  it('classifies confidence case-insensitively', () => {
    expect(toDecisionView(entry({ confidence: 'HIGH' })).confidenceClass).toBe('high');
    expect(toDecisionView(entry({ confidence: 'Medium' })).confidenceClass).toBe('medium');
    expect(toDecisionView(entry({ confidence: 'low' })).confidenceClass).toBe('low');
  });

  it('falls back to unknown for non-conventional confidence values', () => {
    expect(toDecisionView(entry({ confidence: 'maybe' })).confidenceClass).toBe('unknown');
    expect(toDecisionView(entry({ confidence: '' })).confidenceClass).toBe('unknown');
  });

  it('coerces non-string fields to empty strings', () => {
    const view = toDecisionView(entry({ chosen: 123 as unknown as string }));
    expect(view.chosen).toBe('');
  });
});
