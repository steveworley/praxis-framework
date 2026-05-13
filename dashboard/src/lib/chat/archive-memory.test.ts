import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeArchiveMemory } from './archive-memory.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-archive-'));
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

describe('executeArchiveMemory', () => {
  it('refuses invalid slug shape', async () => {
    const r = await executeArchiveMemory(tempDir, { slug: 'NotASlug' });
    expect(r.ok).toBe(false);
  });

  it('refuses when no entry matches the slug', async () => {
    const r = await executeArchiveMemory(tempDir, { slug: 'never-existed' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no memory entry found/);
  });

  it('moves the file under memory/archived/, preserving subpath', async () => {
    await seedMemory(
      'memory/people/alice.md',
      `---\ncreated: 2026-01-01\nupdated: 2026-04-01\n---\n\n# Alice\n\nNotes.\n`,
    );
    const r = await executeArchiveMemory(
      tempDir,
      { slug: 'alice', reason: 'left the account' },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['source_path']).toBe('memory/people/alice.md');
    expect(r.data['archived_path']).toBe('memory/archived/people/alice.md');

    // Source removed, target present.
    const sourceExists = await fileExists(path.join(tempDir, 'memory/people/alice.md'));
    expect(sourceExists).toBe(false);
    const target = await fs.readFile(
      path.join(tempDir, 'memory/archived/people/alice.md'),
      'utf-8',
    );
    expect(target).toMatch(/# Alice/);
    expect(target).toMatch(/## Archived/);
    expect(target).toMatch(/archived_at: 2026-05-13T12:00:00\.000Z/);
    expect(target).toMatch(/left the account/);
  });

  it('omits the reason line when none supplied', async () => {
    await seedMemory(
      'memory/notes/loose-thought.md',
      `---\ncreated: 2026-03-01\n---\n\n# Loose thought\n\nbody\n`,
    );
    const r = await executeArchiveMemory(
      tempDir,
      { slug: 'loose-thought' },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    const archived = await fs.readFile(
      path.join(tempDir, 'memory/archived/notes/loose-thought.md'),
      'utf-8',
    );
    expect(archived).toMatch(/archived_at: /);
    // No reason → no extra prose line after the timestamp.
    const lines = archived.split('\n').map((l) => l.trim());
    const archivedIdx = lines.indexOf('## Archived');
    expect(archivedIdx).toBeGreaterThan(-1);
    // Tail after the archived_at line should be just the closing blank line.
    const afterTimestamp = lines
      .slice(archivedIdx + 2)
      .filter((l) => l.length > 0);
    expect(afterTimestamp).toEqual(['archived_at: 2026-05-13T12:00:00.000Z']);
  });

  it('refuses when the target archived path already exists', async () => {
    await seedMemory('memory/people/bob.md', `# Bob\n`);
    await seedMemory('memory/archived/people/bob.md', `# Bob (older)\n`);
    const r = await executeArchiveMemory(tempDir, { slug: 'bob' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
    // Original still in place — no partial move.
    expect(await fileExists(path.join(tempDir, 'memory/people/bob.md'))).toBe(true);
  });

  it('refuses when the slug is already archived', async () => {
    await seedMemory('memory/archived/people/carol.md', `# Carol\n`);
    const r = await executeArchiveMemory(tempDir, { slug: 'carol' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already archived/);
  });

  it('refuses when the slug is ambiguous across categories', async () => {
    await seedMemory('memory/people/dup.md', `# Dup A\n`);
    await seedMemory('memory/notes/dup.md', `# Dup B\n`);
    const r = await executeArchiveMemory(tempDir, { slug: 'dup' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ambiguous/);
  });

  it('lands an audit commit with role attribution and reason in body', async () => {
    await seedMemory(
      'memory/people/erin.md',
      `---\ncreated: 2026-02-01\n---\n\n# Erin\n\nNotes.\n`,
    );
    await initRepoWithBaseline();
    const r = await executeArchiveMemory(
      tempDir,
      { slug: 'erin', reason: 'left the account' },
      new Date('2026-05-13T12:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect(r.summary).toMatch(/^archived memory\/people\/erin\.md · [0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s%x1f%b',
    ]);
    const [author, subject, body] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(memory): archive erin');
    expect(body).toContain('Reason: left the account');
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
