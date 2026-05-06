import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyAgent, countLiveAgents, listLibFiles, loadAgents } from './agents-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-agents-'));
  await fs.mkdir(path.join(tempDir, 'agents', 'proposed'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('classifyAgent', () => {
  it('classifies escalation/reflection agents', () => {
    expect(classifyAgent('## Reflect at the end of every run')).toBe('reflect');
    expect(classifyAgent('Raise an escalation when stuck')).toBe('reflect');
  });

  it('classifies producer agents', () => {
    expect(classifyAgent('Draft personalised emails for prospects')).toBe('produce');
  });

  it('classifies intake/find agents', () => {
    expect(classifyAgent('Find new prospects matching campaign criteria')).toBe('intake');
  });

  it('falls back to act when nothing matches', () => {
    expect(classifyAgent('something completely unrelated to keywords')).toBe('act');
  });
});

describe('loadAgents', () => {
  it('separates live and proposed, skips persona.md and README.md', async () => {
    await fs.writeFile(path.join(tempDir, 'agents', 'persona.md'), '# Persona', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'agents', 'discover.md'),
      '# Discovery Agent\n\nFind new prospects.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'agents', 'draft-emails.md'),
      '# Email Drafting Agent\n\nDraft cold openers.',
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, 'agents', 'proposed', 'README.md'), 'meta', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'agents', 'proposed', 'tender-promoter.md'),
      '# Tender Promoter\n\nPromote a tender hit into manual leads.',
      'utf-8',
    );

    const result = await loadAgents(tempDir);
    expect(result.live.map((a) => a.file)).toEqual(['discover.md', 'draft-emails.md']);
    expect(result.proposed.map((a) => a.file)).toEqual(['proposed/tender-promoter.md']);
    expect(result.live[0]?.verb).toBe('discovery');
    expect(result.live[0]?.tag).toBe('intake');
    expect(result.live[1]?.tag).toBe('produce');
  });

  it('returns empty when agents/ is missing', async () => {
    await fs.rm(path.join(tempDir, 'agents'), { recursive: true });
    const result = await loadAgents(tempDir);
    expect(result.live).toEqual([]);
    expect(result.proposed).toEqual([]);
  });
});

describe('countLiveAgents', () => {
  it('counts .md files excluding persona.md', async () => {
    await fs.writeFile(path.join(tempDir, 'agents', 'persona.md'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'agents', 'a.md'), '', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'agents', 'b.md'), '', 'utf-8');
    expect(await countLiveAgents(tempDir)).toBe(2);
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
