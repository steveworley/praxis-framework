import { describe, expect, it } from 'vitest';

import type { PersistedToolCall } from './conversation.ts';
import { deriveWorkProducts, outputPathToHref } from './work-products.ts';

function call(over: Partial<PersistedToolCall>): PersistedToolCall {
  return {
    name: 'write_output',
    input: {},
    result: { ok: true, data: { path: 'output/document/q1-brief.md', type: 'document', slug: 'q1-brief', status: 'draft' } },
    ...over,
  };
}

describe('outputPathToHref', () => {
  it('maps a repo output path to a dashboard route', () => {
    expect(outputPathToHref('output/document/q1-brief.md')).toBe('/output/document/q1-brief');
  });
  it('preserves nested record segments', () => {
    expect(outputPathToHref('output/record/account/acme/q1-read.md')).toBe('/output/record/account/acme/q1-read');
  });
});

describe('deriveWorkProducts', () => {
  it('derives a ref from a successful write_output call', () => {
    expect(deriveWorkProducts([call({})])).toEqual([
      { type: 'document', slug: 'q1-brief', href: '/output/document/q1-brief', label: 'document · q1-brief' },
    ]);
  });

  it('builds an href for a nested record path', () => {
    const refs = deriveWorkProducts([
      call({ result: { ok: true, data: { path: 'output/record/account/acme/q1-read.md', type: 'record', slug: 'q1-read', status: 'draft' } } }),
    ]);
    expect(refs[0]?.href).toBe('/output/record/account/acme/q1-read');
  });

  it('ignores failed write_output calls', () => {
    expect(deriveWorkProducts([call({ result: { ok: false, error: 'nope' } })])).toEqual([]);
  });

  it('ignores non-write_output tool calls', () => {
    expect(deriveWorkProducts([call({ name: 'write_memory' })])).toEqual([]);
  });

  it('returns empty for undefined toolCalls', () => {
    expect(deriveWorkProducts(undefined)).toEqual([]);
  });
});
