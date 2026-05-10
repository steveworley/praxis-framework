import { describe, expect, it } from 'vitest';
import {
  STEPS,
  firstStep,
  isLastStep,
  nextStep,
  previousStep,
} from './steps.js';

describe('STEPS', () => {
  it('preserves the documented ordering', () => {
    expect(STEPS).toEqual([
      'welcome',
      'organisation',
      'role-definition',
      'path-choice',
      'tool-selection',
      'voice',
      'capabilities',
      'inhibitions',
      'initial-verbs',
      'review',
      'wrote',
    ]);
  });
});

describe('firstStep', () => {
  it('returns welcome', () => {
    expect(firstStep()).toBe('welcome');
  });
});

describe('nextStep', () => {
  it('walks the full sequence', () => {
    expect(nextStep('welcome')).toBe('organisation');
    expect(nextStep('organisation')).toBe('role-definition');
    expect(nextStep('role-definition')).toBe('path-choice');
    expect(nextStep('path-choice')).toBe('tool-selection');
    expect(nextStep('tool-selection')).toBe('voice');
    expect(nextStep('voice')).toBe('capabilities');
    expect(nextStep('capabilities')).toBe('inhibitions');
    expect(nextStep('inhibitions')).toBe('initial-verbs');
    expect(nextStep('initial-verbs')).toBe('review');
    expect(nextStep('review')).toBe('wrote');
  });

  it('returns null past the last step', () => {
    expect(nextStep('wrote')).toBeNull();
  });
});

describe('previousStep', () => {
  it('walks back one step', () => {
    expect(previousStep('organisation')).toBe('welcome');
    expect(previousStep('wrote')).toBe('review');
  });

  it('returns null at the first step', () => {
    expect(previousStep('welcome')).toBeNull();
  });
});

describe('isLastStep', () => {
  it('only matches the terminal step', () => {
    expect(isLastStep('wrote')).toBe(true);
    expect(isLastStep('welcome')).toBe(false);
    expect(isLastStep('review')).toBe(false);
  });
});
