import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadAutonomy,
  parseAutonomyYaml,
  parseMcpsBlock,
  recentAutonomousEdits,
} from './autonomy-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-autonomy-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('parseAutonomyYaml', () => {
  it('parses multiple surfaces with mixed fields', () => {
    const text = [
      '# preamble',
      'surfaces:',
      '  - path: memory/',
      '    mode: full',
      '    why: |',
      '      Persona-shaped notebook.',
      '      Operator prunes; I notice.',
      '',
      '  - path: verbs/proposed/',
      '    mode: full',
      '    why: |',
      '      Drafts of new verbs.',
      '',
      '  - path: lib/research-strategies.yaml',
      '    mode: append-only',
      '    max_pending: 5',
      '    why: |',
      '      Notes I gather while researching.',
      '',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces).toHaveLength(3);
    expect(surfaces[0]).toEqual({
      path: 'memory/',
      mode: 'full',
      why: 'Persona-shaped notebook.\nOperator prunes; I notice.',
    });
    expect(surfaces[1]).toEqual({
      path: 'verbs/proposed/',
      mode: 'full',
      why: 'Drafts of new verbs.',
    });
    expect(surfaces[2]).toEqual({
      path: 'lib/research-strategies.yaml',
      mode: 'append-only',
      max_pending: 5,
      why: 'Notes I gather while researching.',
    });
  });

  it('parses root_key and unique_by on append-only surfaces', () => {
    const text = [
      'surfaces:',
      '  - path: lib/research-strategies.yaml',
      '    mode: append-only',
      '    max_pending: 5',
      '    root_key: strategies',
      '    unique_by: id',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]).toEqual({
      path: 'lib/research-strategies.yaml',
      mode: 'append-only',
      max_pending: 5,
      root_key: 'strategies',
      unique_by: 'id',
    });
  });

  it('parses soft_fields as a block sequence on inline-enrichment surfaces', () => {
    const text = [
      'surfaces:',
      '  - path: lib/team.yaml',
      '    mode: inline-enrichment',
      '    root_key: members',
      '    unique_by: id',
      '    soft_fields:',
      '      - notes',
      '      - last_observed_at',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]).toEqual({
      path: 'lib/team.yaml',
      mode: 'inline-enrichment',
      root_key: 'members',
      unique_by: 'id',
      soft_fields: ['notes', 'last_observed_at'],
    });
  });

  it('parses soft_fields as an inline flow sequence', () => {
    const text = [
      'surfaces:',
      '  - path: lib/team.yaml',
      '    mode: inline-enrichment',
      '    root_key: members',
      '    unique_by: id',
      '    soft_fields: [notes, last_observed_at]',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.soft_fields).toEqual(['notes', 'last_observed_at']);
  });

  it('omits soft_fields when the list is empty', () => {
    const text = [
      'surfaces:',
      '  - path: lib/team.yaml',
      '    mode: inline-enrichment',
      '    root_key: members',
      '    unique_by: id',
      '    soft_fields: []',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.soft_fields).toBeUndefined();
  });

  it('preserves multi-line block scalars exactly', () => {
    const text = [
      'surfaces:',
      '  - path: memory/',
      '    mode: full',
      '    why: |',
      '      line one',
      '      line two',
      '      line three',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.why).toBe('line one\nline two\nline three');
  });

  it('parses bounds as inline-flow per parameter', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      sends_per_day: { min: 10, max: 100, step: 5 }',
      '      weeks_to_full_send_rate: { min: 4, max: 12 }',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]).toEqual({
      path: 'lib/warmup.yaml',
      mode: 'bounded',
      bounds: {
        sends_per_day: { min: 10, max: 100, step: 5 },
        weeks_to_full_send_rate: { min: 4, max: 12 },
      },
    });
  });

  it('parses bounds as block-mapping per parameter', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      sends_per_day:',
      '        min: 10',
      '        max: 100',
      '        step: 5',
      '      new_thread_ratio:',
      '        min: 0.1',
      '        max: 0.9',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.bounds).toEqual({
      sends_per_day: { min: 10, max: 100, step: 5 },
      new_thread_ratio: { min: 0.1, max: 0.9 },
    });
  });

  it('parses bounds with decimal min/max/step values', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      confidence_threshold: { min: 0.05, max: 0.95, step: 0.05 }',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.bounds?.['confidence_threshold']).toEqual({
      min: 0.05,
      max: 0.95,
      step: 0.05,
    });
  });

  it('drops bound entries missing min or max', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      no_min: { max: 100 }',
      '      no_max: { min: 0 }',
      '      good: { min: 0, max: 10 }',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.bounds).toEqual({
      good: { min: 0, max: 10 },
    });
  });

  it('ignores extra keys inside a bound', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      sends_per_day: { min: 10, max: 100, step: 5, surprise: yes }',
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.bounds).toEqual({
      sends_per_day: { min: 10, max: 100, step: 5 },
    });
  });

  it('omits bounds when the map is empty', () => {
    const text = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      // Nothing indented under bounds.
    ].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.bounds).toBeUndefined();
  });

  it('falls back to gated when mode is unknown', () => {
    const text = ['surfaces:', '  - path: lib/foo.yaml', '    mode: nuclear'].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]?.mode).toBe('gated');
  });

  it('returns empty when surfaces: key is absent', () => {
    expect(parseAutonomyYaml('# nothing here\n')).toEqual([]);
  });

  it('skips entries without a path', () => {
    const text = ['surfaces:', '  - mode: full', '    why: orphan'].join('\n');
    expect(parseAutonomyYaml(text)).toEqual([]);
  });

  it('strips surrounding quotes on inline values', () => {
    const text = ['surfaces:', '  - path: "memory/"', "    mode: 'full'"].join('\n');
    const surfaces = parseAutonomyYaml(text);
    expect(surfaces[0]).toEqual({ path: 'memory/', mode: 'full' });
  });
});

describe('loadAutonomy', () => {
  it('returns null when lib/autonomy.yaml is missing', async () => {
    expect(await loadAutonomy(tempDir)).toBeNull();
  });

  it('returns the parsed config when the file exists', async () => {
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      ['surfaces:', '  - path: memory/', '    mode: full'].join('\n'),
      'utf-8',
    );
    const cfg = await loadAutonomy(tempDir);
    expect(cfg).not.toBeNull();
    expect(cfg?.surfaces).toEqual([{ path: 'memory/', mode: 'full' }]);
  });

  it('round-trips a yaml file with mcps: block', async () => {
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      [
        'surfaces:',
        '  - path: memory/',
        '    mode: full',
        '',
        'mcps:',
        '  slack: allow',
        '  gmail: allow',
        '  playwright: deny',
      ].join('\n'),
      'utf-8',
    );
    const cfg = await loadAutonomy(tempDir);
    expect(cfg).not.toBeNull();
    expect(cfg?.surfaces).toEqual([{ path: 'memory/', mode: 'full' }]);
    expect(cfg?.mcps).toEqual({
      slack: 'allow',
      gmail: 'allow',
      playwright: 'deny',
    });
  });
});

describe('parseMcpsBlock', () => {
  it('returns null when the block is absent', () => {
    expect(parseMcpsBlock('surfaces:\n  - path: memory/\n    mode: full\n')).toBeNull();
  });

  it('parses allow + deny entries', () => {
    const text = ['mcps:', '  slack: allow', '  gmail: deny'].join('\n');
    expect(parseMcpsBlock(text)).toEqual({ slack: 'allow', gmail: 'deny' });
  });

  it('drops entries with values outside allow/deny', () => {
    const text = ['mcps:', '  slack: allow', '  bad: maybe'].join('\n');
    expect(parseMcpsBlock(text)).toEqual({ slack: 'allow' });
  });

  it('strips quoted values', () => {
    const text = ['mcps:', '  slack: "allow"', "  gmail: 'deny'"].join('\n');
    expect(parseMcpsBlock(text)).toEqual({ slack: 'allow', gmail: 'deny' });
  });

  it('returns null when the block is empty', () => {
    expect(parseMcpsBlock('mcps:\n# nothing\n')).toBeNull();
  });

  it('stops at the next top-level key', () => {
    const text = [
      'mcps:',
      '  slack: allow',
      'surfaces:',
      '  - path: memory/',
      '    mode: full',
    ].join('\n');
    expect(parseMcpsBlock(text)).toEqual({ slack: 'allow' });
  });

  it('coexists with a preceding surfaces: block', () => {
    const text = [
      'surfaces:',
      '  - path: memory/',
      '    mode: full',
      'mcps:',
      '  slack: allow',
    ].join('\n');
    expect(parseMcpsBlock(text)).toEqual({ slack: 'allow' });
  });
});

describe('parseMcpsBlock — per-tool allow lists', () => {
  it('keeps the scalar shorthand working', () => {
    const out = parseMcpsBlock(['mcps:', '  slack: allow', '  playwright: deny'].join('\n'));
    expect(out).toEqual({ slack: 'allow', playwright: 'deny' });
  });

  it('parses a flow-sequence allow list', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow: [read_secret, write_secret]'].join('\n'),
    );
    expect(out).toEqual({ vault: { allow: ['read_secret', 'write_secret'] } });
  });

  it('parses a block-sequence allow list', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow:', '      - read_secret', '      - write_secret'].join('\n'),
    );
    expect(out).toEqual({ vault: { allow: ['read_secret', 'write_secret'] } });
  });

  it('mixes scalar and object entries', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  slack: allow', '  vault:', '    allow: [write_secret]', '  playwright: deny'].join('\n'),
    );
    expect(out).toEqual({
      slack: 'allow',
      vault: { allow: ['write_secret'] },
      playwright: 'deny',
    });
  });

  it('strips quotes from tool names', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow: ["read_secret", \'write_secret\']'].join('\n'),
    );
    expect(out).toEqual({ vault: { allow: ['read_secret', 'write_secret'] } });
  });

  it('drops an object entry with an empty allow list (default-deny)', () => {
    const out = parseMcpsBlock(['mcps:', '  vault:', '    allow: []'].join('\n'));
    expect(out).toBeNull();
  });

  it('drops an object entry with no allow key at all (default-deny)', () => {
    const out = parseMcpsBlock(['mcps:', '  vault:', '    note: nothing here'].join('\n'));
    expect(out).toBeNull();
  });

  it('stops at the next top-level key', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow: [write_secret]', 'surfaces:', '  - path: memory/'].join('\n'),
    );
    expect(out).toEqual({ vault: { allow: ['write_secret'] } });
  });

  it('ignores comments inside an object entry', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    # only the safe ones', '    allow: [write_secret]'].join('\n'),
    );
    expect(out).toEqual({ vault: { allow: ['write_secret'] } });
  });
});

describe('parseMcpsBlock — an entry it does not fully understand is dropped', () => {
  it('drops the entry when a deny: key carries a sequence', () => {
    // The near-universal allow/deny idiom. The items under `deny:` must never
    // be read as allow-list members — that would invert a denial into a grant.
    const out = parseMcpsBlock(
      [
        'mcps:',
        '  vault:',
        '    allow:',
        '      - read_secret',
        '    deny:',
        '      - delete_secret',
      ].join('\n'),
    );
    expect(out).toBeNull();
  });

  it("drops the entry when a typo'd key carries a sequence", () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '  ', '    alow:', '      - read_secret'].join('\n'),
    );
    expect(out).toBeNull();
  });

  it('drops the entry when a prose key carries a sequence', () => {
    const out = parseMcpsBlock(
      [
        'mcps:',
        '  vault:',
        '    allow:',
        '      - read_secret',
        '    note:',
        '      - never call delete_secret',
      ].join('\n'),
    );
    expect(out).toBeNull();
  });

  it('drops only the unreadable entry, leaving its siblings intact', () => {
    const out = parseMcpsBlock(
      [
        'mcps:',
        '  slack: allow',
        '  vault:',
        '    allow:',
        '      - read_secret',
        '    deny:',
        '      - delete_secret',
        '  gmail: deny',
      ].join('\n'),
    );
    expect(out).toEqual({ slack: 'allow', gmail: 'deny' });
  });

  it('drops the entry when a sequence item precedes any allow: key', () => {
    const out = parseMcpsBlock(['mcps:', '  vault:', '      - read_secret'].join('\n'));
    expect(out).toBeNull();
  });

  it('drops the entry when a stray item trails a flow allow list', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow: [read_secret]', '    - delete_secret'].join('\n'),
    );
    expect(out).toBeNull();
  });

  it('still parses the valid shapes after the tightening', () => {
    const flow = parseMcpsBlock(
      ['mcps:', '  vault:', '    allow: [read_secret, write_secret]'].join('\n'),
    );
    expect(flow).toEqual({ vault: { allow: ['read_secret', 'write_secret'] } });

    const block = parseMcpsBlock(
      [
        'mcps:',
        '  slack: allow',
        '  vault:',
        '    # only the safe ones',
        '    allow:',
        '',
        '      - read_secret',
        '      - write_secret',
        '  playwright: deny',
      ].join('\n'),
    );
    expect(block).toEqual({
      slack: 'allow',
      vault: { allow: ['read_secret', 'write_secret'] },
      playwright: 'deny',
    });
  });
});

describe('parseMcpsBlock — prototype keys', () => {
  it('records no entry for a __proto__ server name in scalar form', () => {
    expect(parseMcpsBlock(['mcps:', '  __proto__: allow'].join('\n'))).toBeNull();
  });

  it('records no entry for a __proto__ server name in object form', () => {
    expect(
      parseMcpsBlock(['mcps:', '  __proto__:', '    allow: [anything]'].join('\n')),
    ).toBeNull();
  });

  it('does not let a __proto__ entry reshape the map for other servers', () => {
    const out = parseMcpsBlock(
      ['mcps:', '  __proto__:', '    allow: [anything]', '  slack: allow'].join('\n'),
    );
    expect(out).toEqual({ slack: 'allow' });
    expect(out?.['allow']).toBeUndefined();
    expect(out?.['vault']).toBeUndefined();
  });

  it('does not resolve inherited properties for unlisted server names', () => {
    const out = parseMcpsBlock(['mcps:', '  slack: allow'].join('\n'));
    expect(out).not.toBeNull();
    expect(out?.['__proto__']).toBeUndefined();
    expect(out?.['toString']).toBeUndefined();
    expect(out?.['constructor']).toBeUndefined();
  });
});

describe('recentAutonomousEdits', () => {
  async function initRepo(dir: string): Promise<void> {
    const git = simpleGit(dir);
    await git.init();
    // Local config so test commits don't depend on the host's git identity
    // (and so we can author commits from multiple identities).
    await git.addConfig('user.email', 'host@example.test', false, 'local');
    await git.addConfig('user.name', 'Host User', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
  }

  async function commitAs(
    dir: string,
    file: string,
    body: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<void> {
    const full = path.join(dir, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf-8');
    const git = simpleGit(dir);
    await git.add(file);
    await git.raw(['commit', `--author=${author.name} <${author.email}>`, '-m', message]);
  }

  it('returns empty when the directory is not a git repo', async () => {
    const out = await recentAutonomousEdits(tempDir);
    expect(out).toEqual([]);
  });

  it('filters by author email', async () => {
    await initRepo(tempDir);
    await commitAs(tempDir, 'memory/note-a.md', '# A', 'memory: note A', {
      name: 'Sam Parker',
      email: 'sam@example.test',
    });
    await commitAs(tempDir, 'README.md', 'readme', 'chore: update readme', {
      name: 'Operator',
      email: 'operator@example.test',
    });
    await commitAs(tempDir, 'memory/note-b.md', '# B', 'memory: note B', {
      name: 'Sam Parker',
      email: 'sam@example.test',
    });

    const edits = await recentAutonomousEdits(tempDir, { role_email: 'sam@example.test' });
    expect(edits).toHaveLength(2);
    for (const e of edits) {
      expect(e.author_email).toBe('sam@example.test');
      expect(e.short_sha).toHaveLength(7);
      expect(e.message).toMatch(/^memory:/);
    }
    // Newest commit first.
    expect(edits[0]?.message).toBe('memory: note B');
    expect(edits[1]?.message).toBe('memory: note A');
    expect(edits[0]?.files).toContain('memory/note-b.md');
  });

  it('filters by autonomous_paths', async () => {
    await initRepo(tempDir);
    const author = { name: 'Sam Parker', email: 'sam@example.test' };
    await commitAs(tempDir, 'memory/note.md', '# m', 'memory: note', author);
    await commitAs(tempDir, 'lib/customers.yaml', 'c: 1', 'lib: customers', author);
    await commitAs(tempDir, 'verbs/proposed/draft.md', '# d', 'proposed: draft', author);

    const edits = await recentAutonomousEdits(tempDir, {
      role_email: 'sam@example.test',
      autonomous_paths: ['memory/', 'verbs/proposed/'],
    });
    expect(edits.map((e) => e.message).sort()).toEqual(['memory: note', 'proposed: draft']);
  });

  it('respects the limit', async () => {
    await initRepo(tempDir);
    const author = { name: 'Sam Parker', email: 'sam@example.test' };
    for (let i = 0; i < 4; i++) {
      await commitAs(tempDir, `memory/note-${i}.md`, `# ${i}`, `memory: ${i}`, author);
    }
    const edits = await recentAutonomousEdits(tempDir, {
      role_email: 'sam@example.test',
      limit: 2,
    });
    expect(edits).toHaveLength(2);
  });

  it('falls back to role_name when email is not given', async () => {
    await initRepo(tempDir);
    const author = { name: 'Sam Parker', email: 'sam@example.test' };
    await commitAs(tempDir, 'memory/n.md', '# n', 'memory: n', author);
    await commitAs(tempDir, 'README.md', 'r', 'chore: r', {
      name: 'Operator',
      email: 'operator@example.test',
    });

    const edits = await recentAutonomousEdits(tempDir, { role_name: 'Sam Parker' });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.author_name).toBe('Sam Parker');
  });
});
