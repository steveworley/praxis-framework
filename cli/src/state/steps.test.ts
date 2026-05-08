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
      'stub-voice',
      'stub-review',
      'done',
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
    expect(nextStep('path-choice')).toBe('stub-voice');
    expect(nextStep('stub-voice')).toBe('stub-review');
    expect(nextStep('stub-review')).toBe('done');
  });

  it('returns null past the last step', () => {
    expect(nextStep('done')).toBeNull();
  });
});

describe('previousStep', () => {
  it('walks back one step', () => {
    expect(previousStep('organisation')).toBe('welcome');
    expect(previousStep('done')).toBe('stub-review');
  });

  it('returns null at the first step', () => {
    expect(previousStep('welcome')).toBeNull();
  });
});

describe('isLastStep', () => {
  it('only matches done', () => {
    expect(isLastStep('done')).toBe(true);
    expect(isLastStep('welcome')).toBe(false);
    expect(isLastStep('stub-review')).toBe(false);
  });
});
