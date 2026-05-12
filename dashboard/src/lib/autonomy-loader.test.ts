import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadAutonomy,
  parseAutonomyYaml,
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
