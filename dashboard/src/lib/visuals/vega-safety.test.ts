import { describe, expect, it } from 'vitest';

import { parseSafeVegaSpec } from './vega-safety.ts';

describe('parseSafeVegaSpec', () => {
  it('accepts an inline-data spec', () => {
    const r = parseSafeVegaSpec('{"data":{"values":[{"a":1}]},"mark":"bar"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec).toMatchObject({ mark: 'bar' });
  });

  it('rejects a spec whose data loads a remote url', () => {
    const r = parseSafeVegaSpec('{"data":{"url":"http://evil.test/x.json"},"mark":"line"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/url/i);
  });

  it('rejects a spec with a nested layer data url', () => {
    const r = parseSafeVegaSpec(
      '{"layer":[{"data":{"url":"http://evil.test/x.json"},"mark":"point"}]}',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const r = parseSafeVegaSpec('{nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/json/i);
  });
});
