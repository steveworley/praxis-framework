import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORE_FIELDS,
  loadBusinessContext,
  parseBusinessContext,
  serializeBusinessContext,
  writeBusinessContext,
  type BusinessContext,
} from './business-context.ts';

describe('parseBusinessContext', () => {
  it('parses core + custom fields preserving order', () => {
    const yaml = [
      'version: 1',
      'business_context:',
      '  - key: what_we_do',
      '    label: What we do',
      '    value: We roast coffee.',
      '  - key: market_positioning',
      '    label: Market positioning',
      '    value: Premium.',
    ].join('\n');
    const bc = parseBusinessContext(yaml);
    expect(bc.version).toBe(1);
    expect(bc.business_context).toEqual([
      { key: 'what_we_do', label: 'What we do', value: 'We roast coffee.' },
      { key: 'market_positioning', label: 'Market positioning', value: 'Premium.' },
    ]);
  });

  it('defaults value to empty string when omitted', () => {
    const yaml = [
      'version: 1',
      'business_context:',
      '  - key: name',
      '    label: Name',
    ].join('\n');
    const bc = parseBusinessContext(yaml);
    expect(bc.business_context).toEqual([{ key: 'name', label: 'Name', value: '' }]);
  });

  it('throws on a malformed shape (missing business_context list)', () => {
    expect(() => parseBusinessContext('version: 1\nfoo: bar')).toThrow();
  });
});

describe('serializeBusinessContext', () => {
  it('round-trips multi-line prose values', () => {
    const bc: BusinessContext = {
      version: 1,
      business_context: [
        { key: 'what_we_do', label: 'What we do', value: 'Line one.\nLine two.' },
      ],
    };
    const round = parseBusinessContext(serializeBusinessContext(bc));
    expect(round).toEqual(bc);
  });
});

describe('CORE_FIELDS', () => {
  it('lists the org keys in display order', () => {
    expect(CORE_FIELDS.map((f) => f.key)).toEqual([
      'name', 'website', 'sector', 'size',
      'what_we_do', 'who_we_serve', 'what_makes_us_different',
    ]);
  });
});

describe('loadBusinessContext', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-bc-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns null when the role predates this feature', async () => {
    expect(await loadBusinessContext(tmp)).toBeNull();
  });

  it('round-trips through writeBusinessContext', async () => {
    const bc: BusinessContext = {
      version: 1,
      business_context: [{ key: 'name', label: 'Name', value: 'Acme Co' }],
    };
    await writeBusinessContext(tmp, bc);
    expect(await loadBusinessContext(tmp)).toEqual(bc);
  });
});
