import { describe, expect, it } from 'vitest';

import { buildChipHref } from './filter-href.ts';

describe('buildChipHref', () => {
  it('returns the bare path when every key equals its default', () => {
    const href = buildChipHref({
      pathname: '/escalations',
      current: { status: 'all', kind: 'all' },
      group: 'status',
      value: 'all',
      defaults: { status: 'all', kind: 'all' },
    });
    expect(href).toBe('/escalations');
  });

  it('omits a key when its value matches the configured default', () => {
    const href = buildChipHref({
      pathname: '/escalations',
      current: { status: 'open', kind: 'all' },
      group: 'kind',
      value: 'help',
      defaults: { status: 'all', kind: 'all' },
    });
    // kind=help is non-default, status=open is non-default → both encoded.
    expect(href).toBe('/escalations?status=open&kind=help');
  });

  it('replaces the value for the group being changed', () => {
    const href = buildChipHref({
      pathname: '/escalations',
      current: { status: 'open', kind: 'help' },
      group: 'status',
      value: 'resolved',
      defaults: { status: 'all', kind: 'all' },
    });
    expect(href).toBe('/escalations?status=resolved&kind=help');
  });

  it('drops empty-string values', () => {
    const href = buildChipHref({
      pathname: '/activity',
      current: { action: '' },
      group: 'action',
      value: 'decision',
      defaults: { action: 'all' },
    });
    expect(href).toBe('/activity?action=decision');
  });
});
