import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeConsolidateMemory } from './consolidate-memory.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-consolidate-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedMemory(rel: string, body: string): Promise<void> {
  const abs = path.join(tempDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

async function initRepoWithBaseline(): Promise<void> {
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.name', 'Operator', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await git.add('.');
  await git.raw([
    '-c',
    'user.name=Operator',
    '-c',
    'user.email=op@example.test',
    'commit',
    '--author=Operator <op@example.test>',
    '--no-gpg-sign',
    '-m',
    'init',
  ]);
}

describe('executeConsolidateMemory', () => {
  it('refuses when fewer than 2 source slugs supplied', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice'],
      new_title: 'Canonical Alice',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 2/i);
  });

  it('refuses when a source slug is not found', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'never-existed'],
      new_title: 'Canonical',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no memory entry found/);
  });

  it('refuses when a source slug is already archived', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    await seedMemory('memory/archived/people/bob.md', '# Bob\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'bob'],
      new_title: 'Canonical',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already archived/);
  });

  it('refuses when the derived new-slug collides with a live entry', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    await seedMemory('memory/people/bob.md', '# Bob\n');
    await seedMemory('memory/canonical-contact.md', '# Canonical Contact\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'bob'],
      new_title: 'Canonical Contact',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/collides with existing entry/);
  });

  it('refuses when the derived new-slug collides with an archived entry', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    await seedMemory('memory/people/bob.md', '# Bob\n');
    await seedMemory('memory/archived/canonical-contact.md', '# Older Canonical\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'bob'],
      new_title: 'Canonical Contact',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/collides with existing entry/);
  });

  it('folds three sources into a single new top-level entry with back-references', async () => {
    await seedMemory(
      'memory/people/alice-old.md',
      `---\ncreated: 2026-01-01\n---\n\n# Alice (old)\n\nFirst note.\n`,
    );
    await seedMemory(
      'memory/people/alice-newer.md',
      `---\ncreated: 2026-02-01\n---\n\n# Alice (newer)\n\nSecond note.\n`,
    );
    await seedMemory(
      'memory/people/alice-latest.md',
      `---\ncreated: 2026-03-01\n---\n\n# Alice (latest)\n\nThird note.\n`,
    );

    const r = await executeConsolidateMemory(
      tempDir,
      {
        source_slugs: ['alice-old', 'alice-newer', 'alice-latest'],
        new_title: 'Alice procurement contact',
        new_body: 'Alice is the procurement lead at Library Victoria. Prefers email.',
        reason: 'three overlapping observations about the same contact',
      },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['new_slug']).toBe('alice-procurement-contact');
    expect(r.data['new_path']).toBe('memory/alice-procurement-contact.md');
    expect(r.data['archived']).toEqual([
      'memory/archived/people/alice-old.md',
      'memory/archived/people/alice-newer.md',
      'memory/archived/people/alice-latest.md',
    ]);

    // New entry exists with H1 and body.
    const newEntry = await fs.readFile(
      path.join(tempDir, 'memory/alice-procurement-contact.md'),
      'utf-8',
    );
    expect(newEntry).toMatch(/# Alice procurement contact/);
    expect(newEntry).toMatch(/Alice is the procurement lead at Library Victoria/);
    expect(newEntry).toMatch(/created: 2026-05-13/);

    // Sources removed.
    for (const rel of [
      'memory/people/alice-old.md',
      'memory/people/alice-newer.md',
      'memory/people/alice-latest.md',
    ]) {
      expect(await fileExists(path.join(tempDir, rel))).toBe(false);
    }

    // Sources archived with back-references.
    for (const rel of [
      'memory/archived/people/alice-old.md',
      'memory/archived/people/alice-newer.md',
      'memory/archived/people/alice-latest.md',
    ]) {
      const text = await fs.readFile(path.join(tempDir, rel), 'utf-8');
      expect(text).toMatch(/## Consolidated/);
      expect(text).toMatch(/consolidated_into: alice-procurement-contact/);
      expect(text).toMatch(/three overlapping observations/);
      expect(text).toMatch(/consolidated_at: 2026-05-13T12:00:00\.000Z/);
    }
  });

  it('preserves cross-category subpaths when archiving', async () => {
    await seedMemory(
      'memory/notes/library-victoria-procurement.md',
      `# Library Victoria procurement\n\nFirst observation.\n`,
    );
    await seedMemory(
      'memory/accounts/library-victoria.md',
      `# Library Victoria\n\nAccount-level read.\n`,
    );

    const r = await executeConsolidateMemory(
      tempDir,
      {
        source_slugs: ['library-victoria-procurement', 'library-victoria'],
        new_title: 'Library Victoria canonical',
        new_body: 'Canonical merged view of Library Victoria.',
      },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // New entry sits at memory/<new-slug>.md — top-level, not nested under
    // either source's category.
    expect(r.data['new_path']).toBe('memory/library-victoria-canonical.md');
    expect(
      await fileExists(path.join(tempDir, 'memory/library-victoria-canonical.md')),
    ).toBe(true);
    // Each source was archived under its original subpath.
    expect(
      await fileExists(
        path.join(tempDir, 'memory/archived/notes/library-victoria-procurement.md'),
      ),
    ).toBe(true);
    expect(
      await fileExists(path.join(tempDir, 'memory/archived/accounts/library-victoria.md')),
    ).toBe(true);
  });

  it('lands a single audit commit with the expected subject and body', async () => {
    await seedMemory(
      'memory/people/alice-one.md',
      `---\ncreated: 2026-01-01\n---\n\n# Alice (one)\n\nA.\n`,
    );
    await seedMemory(
      'memory/people/alice-two.md',
      `---\ncreated: 2026-02-01\n---\n\n# Alice (two)\n\nB.\n`,
    );
    await initRepoWithBaseline();

    const r = await executeConsolidateMemory(
      tempDir,
      {
        source_slugs: ['alice-one', 'alice-two'],
        new_title: 'Alice canonical',
        new_body: 'Canonical Alice.',
        reason: 'duplicate',
      },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s%x1f%b',
    ]);
    const [author, subject, body] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(memory): consolidate 2 entries into alice-canonical');
    expect(body).toContain('- alice-one → archived/people/alice-one.md');
    expect(body).toContain('- alice-two → archived/people/alice-two.md');
    expect(body).toContain('Reason: duplicate');

    // The commit should be a single new HEAD over the baseline.
    const count = (await git.raw(['rev-list', '--count', 'HEAD'])).trim();
    expect(count).toBe('2');
  });

  it('refuses when an archive target already exists on disk', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    await seedMemory('memory/people/bob.md', '# Bob\n');
    await seedMemory('memory/archived/people/alice.md', '# Older alice\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'bob'],
      new_title: 'Canonical',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
    // Live alice.md still in place — no partial move.
    expect(await fileExists(path.join(tempDir, 'memory/people/alice.md'))).toBe(true);
    expect(await fileExists(path.join(tempDir, 'memory/people/bob.md'))).toBe(true);
  });

  it('refuses when new_title slugifies to empty', async () => {
    await seedMemory('memory/people/alice.md', '# Alice\n');
    await seedMemory('memory/people/bob.md', '# Bob\n');
    const r = await executeConsolidateMemory(tempDir, {
      source_slugs: ['alice', 'bob'],
      new_title: '!!!',
      new_body: 'merged.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slugified to an empty string/);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
