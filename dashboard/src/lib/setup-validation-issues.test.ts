import { describe, expect, it } from 'vitest';

import { formatSetupValidationIssues, humanizeIssuePath } from './setup-validation-issues.ts';

describe('humanizeIssuePath', () => {
  it('formats the reported example with a numeric segment', () => {
    expect(humanizeIssuePath('initial_verbs.2.description.0')).toBe(
      'Initial verbs › item 3 › description',
    );
  });

  it('formats a nested object path with known leaf key', () => {
    expect(humanizeIssuePath('role_definition.role_name')).toBe('Role definition › Role name');
  });

  it('humanizes underscores for an unmapped key', () => {
    expect(humanizeIssuePath('some_unmapped_field')).toBe('some unmapped field');
  });

  it('returns "Form" for an empty path', () => {
    expect(humanizeIssuePath('')).toBe('Form');
  });
});

describe('formatSetupValidationIssues', () => {
  it('formats the exact reported example in order', () => {
    const issues = [
      { path: 'initial_verbs.2.description.0', message: 'String must contain at most 280 character(s)' },
      { path: 'initial_verbs.4.description.0', message: 'String must contain at most 280 character(s)' },
    ];
    expect(formatSetupValidationIssues(issues)).toEqual([
      {
        label: 'Initial verbs › item 3 › description',
        message: 'String must contain at most 280 character(s)',
      },
      {
        label: 'Initial verbs › item 5 › description',
        message: 'String must contain at most 280 character(s)',
      },
    ]);
  });

  it('returns an empty array for non-array input', () => {
    expect(formatSetupValidationIssues(undefined)).toEqual([]);
    expect(formatSetupValidationIssues(null)).toEqual([]);
    expect(formatSetupValidationIssues({})).toEqual([]);
  });

  it('skips entries that are not objects', () => {
    const issues = ['nope', 42, null, { path: 'slug', message: 'Required' }];
    expect(formatSetupValidationIssues(issues)).toEqual([{ label: 'slug', message: 'Required' }]);
  });

  it('tolerates an entry missing message without throwing', () => {
    const issues = [{ path: 'identity.role_name' }];
    expect(() => formatSetupValidationIssues(issues)).not.toThrow();
    expect(formatSetupValidationIssues(issues)).toEqual([
      { label: 'Identity › Role name', message: '' },
    ]);
  });

  it('tolerates an entry missing path', () => {
    const issues = [{ message: 'Something went wrong' }];
    expect(formatSetupValidationIssues(issues)).toEqual([
      { label: 'Form', message: 'Something went wrong' },
    ]);
  });
});
