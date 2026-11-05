import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeListRoleFiles, LIST_ROLE_FILES_MAX_ENTRIES } from './list-role-files.ts';

let tempDir: string;
let roleHome: string;

beforeEach(async () => {
  // The role home sits one level below tempDir so symlink-escape tests have a
  // sibling directory outside the role home to point at.
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-list-'));
  roleHome = path.join(tempDir, 'role');
  await fs.mkdir(roleHome);
  await fs.writeFile(path.join(roleHome, 'persona.md'), '# Iris\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

interface Entry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  mtime: string;
}

async function writeRoleFile(rel: string, content = 'x\n', mtime?: Date): Promise<void> {
  const abs = path.join(roleHome, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  if (mtime) await fs.utimes(abs, mtime, mtime);
}

async function list(input: Record<string, unknown>): Promise<Entry[]> {
  const r = await executeListRoleFiles(roleHome, input);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.data['entries'] as Entry[];
}

async function names(input: Record<string, unknown>): Promise<string[]> {
  return (await list(input)).map((e) => e.name);
}

async function expectRefusal(input: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const r = await executeListRoleFiles(roleHome, input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}

const ESCALATION =
  '2026-11-05-6e1b-bounty-solicitation-from-sebastian-romeo-your-call-before-i-.md';

describe('executeListRoleFiles — happy path', () => {
  it('lists escalation filenames with type, size and ISO mtime', async () => {
    await writeRoleFile(`escalations/${ESCALATION}`, 'hello\n');
    await writeRoleFile('escalations/2026-11-01-ab12-help.md', 'hi\n');

    const r = await executeListRoleFiles(roleHome, { path: 'escalations' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('escalations');
    expect(r.data['truncated']).toBe(false);
    expect(r.data['total']).toBe(2);
    const entries = r.data['entries'] as Entry[];
    expect(entries.map((e) => e.name)).toEqual(['2026-11-01-ab12-help.md', ESCALATION]);
    expect(entries[1]).toMatchObject({ name: ESCALATION, type: 'file', size: 6 });
    expect(entries[1]!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(r.summary).toContain('escalations');
  });

  it('reports subdirectories one level deep without recursing', async () => {
    await writeRoleFile('output/draft/email.md');
    await writeRoleFile('output/document/brief.md');

    const entries = await list({ path: 'output' });

    expect(entries).toEqual([
      expect.objectContaining({ name: 'document', type: 'dir' }),
      expect.objectContaining({ name: 'draft', type: 'dir' }),
    ]);
    expect(entries[0]).not.toHaveProperty('size');
  });

  it('lists a nested directory such as output/draft', async () => {
    await writeRoleFile('output/draft/2026-11-05-reply-to-vendor.md');
    expect(await names({ path: 'output/draft' })).toEqual(['2026-11-05-reply-to-vendor.md']);
  });

  it('normalises ./ and a trailing slash', async () => {
    await writeRoleFile('memory/people/mary.md');
    const r = await executeListRoleFiles(roleHome, { path: './memory/' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data['path']).toBe('memory');
  });

  it('returns an empty list for an empty allowed directory', async () => {
    await fs.mkdir(path.join(roleHome, 'escalations'));
    expect(await names({ path: 'escalations' })).toEqual([]);
  });
});

describe('executeListRoleFiles — role-home root', () => {
  it.each(['.', './', ''])('lists only allowed entries for %j', async (p) => {
    await writeRoleFile('CLAUDE.md');
    await writeRoleFile('lib/compliance.yaml');
    await writeRoleFile('escalations/a.md');
    await writeRoleFile('.env', 'SECRET=1\n');
    await writeRoleFile('.tokens/google.json');
    await writeRoleFile('state/session.json');
    await writeRoleFile('README.md');
    await writeRoleFile('campaigns/q3/plan.md');

    expect(await names({ path: p })).toEqual(['CLAUDE.md', 'escalations', 'lib', 'persona.md']);
  });

  it('defaults to the root when path is omitted', async () => {
    await writeRoleFile('lib/compliance.yaml');
    expect(await names({})).toEqual(['lib', 'persona.md']);
  });
});

describe('executeListRoleFiles — policy refusals', () => {
  it.each(['campaigns', 'dashboard', 'docs/notes'])(
    'refuses %s (not on the allow list)',
    async (rel) => {
      await fs.mkdir(path.join(roleHome, rel), { recursive: true });
      await expectRefusal({ path: rel }, /list_role_files: refusing .*not on the read allow list/);
    },
  );

  it.each(['.git', '.tokens', 'state', 'lib/credentials', 'memory/.git'])(
    'refuses denied directory %s',
    async (rel) => {
      await fs.mkdir(path.join(roleHome, rel), { recursive: true });
      await expectRefusal({ path: rel }, /secret|credential/i);
    },
  );

  it('rejects `..`, absolute paths and null bytes', async () => {
    await expectRefusal({ path: '../' }, /unsafe path/);
    await expectRefusal({ path: 'lib/../lib' }, /unsafe path/);
    await expectRefusal({ path: '/etc' }, /unsafe path/);
    await expectRefusal({ path: roleHome }, /unsafe path/);
    await expectRefusal({ path: 'lib\u0000' }, /unsafe path/);
  });

  it('refuses a missing directory', async () => {
    await expectRefusal({ path: 'escalations' }, /not found/);
  });

  it('refuses a path that is a file and points at read_role_file', async () => {
    await writeRoleFile('lib/compliance.yaml');
    await expectRefusal({ path: 'lib/compliance.yaml' }, /is a file.*read_role_file/);
    await expectRefusal({ path: 'persona.md' }, /is a file/);
  });

  it('refuses invalid input shape', async () => {
    await expectRefusal({ path: 42 }, /list_role_files input invalid/);
    await expectRefusal({ path: 'lib', sort: 'size' }, /list_role_files input invalid/);
  });
});

describe('executeListRoleFiles — omitted entries', () => {
  it('omits secret-shaped files inside an allowed directory', async () => {
    await writeRoleFile('lib/compliance.yaml');
    for (const rel of [
      'lib/.env',
      'lib/.env.local',
      'lib/server.pem',
      'lib/tls.key',
      'lib/google-credentials.json',
      'lib/service-sa-key.json',
      'lib/id_rsa',
      'lib/.tokens/slack.json',
      'lib/state/cursor.json',
      'lib/.git/HEAD',
      'lib/credentials/aws.yaml',
    ]) {
      await writeRoleFile(rel, 'SECRET=1\n');
    }

    expect(await names({ path: 'lib' })).toEqual(['compliance.yaml']);
  });

  it('omits a symlink whose realpath leaves the role home', async () => {
    const outside = path.join(tempDir, 'outside.md');
    await fs.writeFile(outside, 'nope\n', 'utf-8');
    await writeRoleFile('escalations/a.md');
    await fs.symlink(outside, path.join(roleHome, 'escalations', 'escape.md'));
    await fs.symlink(tempDir, path.join(roleHome, 'escalations', 'escape-dir'));

    expect(await names({ path: 'escalations' })).toEqual(['a.md']);
  });

  it('omits a symlink that aliases a denied file inside the role home', async () => {
    await writeRoleFile('.env', 'SECRET=1\n');
    await writeRoleFile('README.md');
    await writeRoleFile('lib/a.yaml');
    await fs.symlink(path.join(roleHome, '.env'), path.join(roleHome, 'lib', 'settings.yaml'));
    await fs.symlink(path.join(roleHome, 'README.md'), path.join(roleHome, 'lib', 'readme.md'));

    expect(await names({ path: 'lib' })).toEqual(['a.yaml']);
  });

  it('omits a broken symlink', async () => {
    await writeRoleFile('lib/a.yaml');
    await fs.symlink(path.join(roleHome, 'lib', 'gone.yaml'), path.join(roleHome, 'lib', 'b.yaml'));
    expect(await names({ path: 'lib' })).toEqual(['a.yaml']);
  });

  it('keeps a symlink that stays inside the allow list, reporting the target type', async () => {
    await writeRoleFile('lib/compliance.yaml', 'a: 1\n');
    await fs.symlink(
      path.join(roleHome, 'lib', 'compliance.yaml'),
      path.join(roleHome, 'lib', 'compliance-link.yaml'),
    );
    const entries = await list({ path: 'lib' });
    expect(entries.map((e) => e.name)).toEqual(['compliance-link.yaml', 'compliance.yaml']);
    expect(entries[0]).toMatchObject({ type: 'file', size: 5 });
  });

  it('refuses listing through a symlinked directory that leaves the role home', async () => {
    const outsideDir = path.join(tempDir, 'elsewhere');
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'data.yaml'), 'x: 1\n', 'utf-8');
    await fs.symlink(outsideDir, path.join(roleHome, 'memory'));
    await expectRefusal({ path: 'memory' }, /outside the role home/);
  });
});

describe('executeListRoleFiles — filter', () => {
  beforeEach(async () => {
    await writeRoleFile(`escalations/${ESCALATION}`);
    await writeRoleFile('escalations/2026-11-01-ab12-help.md');
    await writeRoleFile('escalations/2026-10-30-cd34-bounty-followup.md');
    await writeRoleFile('escalations/notes.txt');
  });

  it('treats a filter without wildcards as a case-insensitive name prefix', async () => {
    expect(await names({ path: 'escalations', filter: '2026-11' })).toEqual([
      '2026-11-01-ab12-help.md',
      ESCALATION,
    ]);
    expect(await names({ path: 'escalations', filter: 'NOTES' })).toEqual(['notes.txt']);
  });

  it('matches * and ? as a glob against the whole name', async () => {
    expect(await names({ path: 'escalations', filter: '*bounty*' })).toEqual([
      '2026-10-30-cd34-bounty-followup.md',
      ESCALATION,
    ]);
    expect(await names({ path: 'escalations', filter: '*.txt' })).toEqual(['notes.txt']);
    expect(await names({ path: 'escalations', filter: '2026-11-0?-ab12-*' })).toEqual([
      '2026-11-01-ab12-help.md',
    ]);
  });

  it('treats regex metacharacters in the filter literally', async () => {
    await writeRoleFile('escalations/a+b.md');
    expect(await names({ path: 'escalations', filter: 'a+b*' })).toEqual(['a+b.md']);
    expect(await names({ path: 'escalations', filter: '*.(md)' })).toEqual([]);
  });

  it('reports total as the filtered count', async () => {
    const r = await executeListRoleFiles(roleHome, { path: 'escalations', filter: '*.md' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data['total']).toBe(3);
  });
});

describe('executeListRoleFiles — sort', () => {
  it('sorts by mtime newest first when sort is mtime, tie-breaking on name', async () => {
    await writeRoleFile('escalations/old.md', 'x', new Date('2026-01-01T00:00:00Z'));
    await writeRoleFile('escalations/new.md', 'x', new Date('2026-11-05T00:00:00Z'));
    await writeRoleFile('escalations/b-mid.md', 'x', new Date('2026-06-01T00:00:00Z'));
    await writeRoleFile('escalations/a-mid.md', 'x', new Date('2026-06-01T00:00:00Z'));

    expect(await names({ path: 'escalations', sort: 'mtime' })).toEqual([
      'new.md',
      'a-mid.md',
      'b-mid.md',
      'old.md',
    ]);
    expect(await names({ path: 'escalations' })).toEqual([
      'a-mid.md',
      'b-mid.md',
      'new.md',
      'old.md',
    ]);
  });
});

describe('executeListRoleFiles — cap', () => {
  it(`caps results at LIST_ROLE_FILES_MAX_ENTRIES with a truncation notice`, async () => {
    const total = LIST_ROLE_FILES_MAX_ENTRIES + 5;
    await fs.mkdir(path.join(roleHome, 'logs'));
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        fs.writeFile(path.join(roleHome, 'logs', `${String(i).padStart(4, '0')}.jsonl`), ''),
      ),
    );

    const r = await executeListRoleFiles(roleHome, { path: 'logs' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = r.data['entries'] as Entry[];
    expect(entries).toHaveLength(LIST_ROLE_FILES_MAX_ENTRIES);
    expect(entries[0]!.name).toBe('0000.jsonl');
    expect(r.data['total']).toBe(total);
    expect(r.data['truncated']).toBe(true);
    expect(r.data['notice']).toMatch(/truncated/i);
    expect(r.data['notice']).toMatch(/filter/);
    expect(r.summary).toMatch(/truncated/i);
  });

  it('does not truncate exactly at the cap', async () => {
    await fs.mkdir(path.join(roleHome, 'logs'));
    await Promise.all(
      Array.from({ length: LIST_ROLE_FILES_MAX_ENTRIES }, (_, i) =>
        fs.writeFile(path.join(roleHome, 'logs', `${i}.jsonl`), ''),
      ),
    );
    const r = await executeListRoleFiles(roleHome, { path: 'logs' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data['truncated']).toBe(false);
      expect(r.data).not.toHaveProperty('notice');
    }
  });
});
