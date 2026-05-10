import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyVerb, countLiveVerbs, listLibFiles, loadVerbs } from './verbs-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-verbs-'));
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('classifyVerb', () => {
  it('classifies escalation/reflection verbs', () => {
    expect(classifyVerb('## Reflect at the end of every run')).toBe('reflect');
    expect(classifyVerb('Raise an escalation when stuck')).toBe('reflect');
  });

  it('classifies producer verbs', () => {
    expect(classifyVerb('Draft personalised emails for prospects')).toBe('produce');
  });

  it('classifies intake/find verbs', () => {
    expect(classifyVerb('Find new prospects matching campaign criteria')).toBe('intake');
  });

  it('falls back to act when nothing matches', () => {
    expect(classifyVerb('something completely unrelated to keywords')).toBe('act');
  });
});

describe('loadVerbs', () => {
  it('separates live and proposed, skips README.md', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'discover.md'),
      '# Discovery Verb\n\nFind new prospects.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'draft-emails.md'),
      '# Email Drafting Verb\n\nDraft cold openers.',
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, 'verbs', 'proposed', 'README.md'), 'meta', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'proposed', 'tender-promoter.md'),
      '# Tender Promoter\n\nPromote a tender hit into manual leads.',
      'utf-8',
    );

    const result = await loadVerbs(tempDir);
    expect(result.live.map((v) => v.file)).toEqual(['discover.md', 'draft-emails.md']);
    expect(result.proposed.map((v) => v.file)).toEqual(['proposed/tender-promoter.md']);
    expect(result.live[0]?.label).toBe('discovery');
    expect(result.live[0]?.tag).toBe('intake');
    expect(result.live[1]?.tag).toBe('produce');
  });

  it('returns empty when verbs/ is missing', async () => {
    await fs.rm(path.join(tempDir, 'verbs'), { recursive: true });
    const result = await loadVerbs(tempDir);
    expect(result.live).toEqual([]);
    expect(result.proposed).toEqual([]);
  });
});

describe('countLiveVerbs', () => {
  it('counts .md files in verbs/', async () => {
    await fs.writeFile(path.join(tempDir, 'verbs', 'a.md'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'verbs', 'b.md'), '', 'utf-8');
    expect(await countLiveVerbs(tempDir)).toBe(2);
  });
});

describe('listLibFiles', () => {
  it('lists yaml/yml files in lib/', async () => {
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'lib', 'customers.yaml'), 'a: 1', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'lib', 'team.yml'), 'b: 2', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'lib', 'ignored.txt'), 'x', 'utf-8');
    expect(await listLibFiles(tempDir)).toEqual(['lib/customers.yaml', 'lib/team.yml']);
  });

  it('returns empty when lib/ is missing', async () => {
    expect(await listLibFiles(tempDir)).toEqual([]);
  });
});
