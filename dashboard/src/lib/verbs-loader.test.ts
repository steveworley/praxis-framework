import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyVerb, countLiveVerbs, listLibFiles, loadVerb, loadVerbs } from './verbs-loader.ts';

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

describe('loadVerb', () => {
  it('parses frontmatter and body for a verb with all fields set', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'escalate.md'),
      [
        '---',
        'verb: reflect',
        'when_to_run: end of every run',
        'inputs: [memory/notes, lib/team.yaml]',
        'outputs: [escalations/]',
        "description: 'Raise a structured ask'",
        'proposed_by: sam',
        'created: 2026-04-01',
        'accepted_at: 2026-04-02',
        'status: accepted',
        '---',
        '',
        '# Escalate Verb',
        '',
        'Body text here.',
      ].join('\n'),
      'utf-8',
    );
    const detail = await loadVerb(tempDir, 'escalate');
    expect(detail).not.toBeNull();
    expect(detail?.slug).toBe('escalate');
    expect(detail?.file).toBe(path.join('verbs', 'escalate.md'));
    expect(detail?.tag).toBe('reflect');
    expect(detail?.frontmatter.verb).toBe('reflect');
    expect(detail?.frontmatter.when_to_run).toBe('end of every run');
    expect(detail?.frontmatter.inputs).toEqual(['memory/notes', 'lib/team.yaml']);
    expect(detail?.frontmatter.outputs).toEqual(['escalations/']);
    expect(detail?.frontmatter.description).toBe('Raise a structured ask');
    expect(detail?.frontmatter.status).toBe('accepted');
    expect(detail?.body).toContain('# Escalate Verb');
    expect(detail?.body).not.toContain('---');
  });

  it('returns null for a non-existent slug', async () => {
    const detail = await loadVerb(tempDir, 'does-not-exist');
    expect(detail).toBeNull();
  });

  it('refuses path-traversal slugs', async () => {
    await expect(loadVerb(tempDir, '../etc/passwd')).rejects.toThrow(/Invalid verb slug/);
    await expect(loadVerb(tempDir, 'BadSlug')).rejects.toThrow(/Invalid verb slug/);
    await expect(loadVerb(tempDir, 'has_underscore')).rejects.toThrow(/Invalid verb slug/);
    await expect(loadVerb(tempDir, '')).rejects.toThrow(/Invalid verb slug/);
  });

  it('handles `<unset>` placeholders without coercion', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'fresh.md'),
      [
        '---',
        'verb: <unset>',
        'when_to_run: <unset>',
        'inputs: []',
        'outputs: []',
        '---',
        '',
        '# Fresh Verb',
        '',
        'Just authored.',
      ].join('\n'),
      'utf-8',
    );
    const detail = await loadVerb(tempDir, 'fresh');
    expect(detail).not.toBeNull();
    expect(detail?.frontmatter.verb).toBe('<unset>');
    expect(detail?.frontmatter.when_to_run).toBe('<unset>');
    expect(detail?.frontmatter.inputs).toEqual([]);
    expect(detail?.frontmatter.outputs).toEqual([]);
    expect(detail?.frontmatter.description).toBeUndefined();
  });

  it('treats missing `inputs` and empty `inputs: []` the same shape', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'missing.md'),
      ['---', 'verb: act', '---', '', '# Missing inputs', ''].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'empty.md'),
      ['---', 'verb: act', 'inputs: []', '---', '', '# Empty inputs', ''].join('\n'),
      'utf-8',
    );
    const missing = await loadVerb(tempDir, 'missing');
    const empty = await loadVerb(tempDir, 'empty');
    // Missing → undefined; empty → []. The detail page treats both as "nothing
    // to show" (length === 0 OR undefined), so they render identically.
    expect(missing?.frontmatter.inputs).toBeUndefined();
    expect(empty?.frontmatter.inputs).toEqual([]);
  });

  it('parses YAML block-list inputs', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'block.md'),
      [
        '---',
        'verb: research',
        'inputs:',
        '  - lib/customers.yaml',
        '  - memory/notes/',
        'outputs:',
        '  - output/document/',
        '---',
        '',
        '# Block-list verb',
      ].join('\n'),
      'utf-8',
    );
    const detail = await loadVerb(tempDir, 'block');
    expect(detail?.frontmatter.inputs).toEqual(['lib/customers.yaml', 'memory/notes/']);
    expect(detail?.frontmatter.outputs).toEqual(['output/document/']);
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
