import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeReadRoleFile, READ_ROLE_FILE_MAX_BYTES } from './read-role-file.ts';

let tempDir: string;
let roleHome: string;

beforeEach(async () => {
  // The role home sits one level below tempDir so symlink-escape tests have a
  // sibling directory outside the role home to point at.
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-read-'));
  roleHome = path.join(tempDir, 'role');
  await fs.mkdir(roleHome);
  await fs.writeFile(path.join(roleHome, 'persona.md'), '# Iris\n\nCISO support.\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeRoleFile(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(roleHome, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function expectRefusal(rel: string, pattern: RegExp): Promise<void> {
  const r = await executeReadRoleFile(roleHome, { path: rel });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}

describe('executeReadRoleFile — happy path', () => {
  it('reads lib/compliance.yaml and returns its text', async () => {
    const yaml = 'controls:\n  - id: ISM-1565\n    rule: privileged users complete training\n';
    await writeRoleFile('lib/compliance.yaml', yaml);

    const r = await executeReadRoleFile(roleHome, { path: 'lib/compliance.yaml' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('lib/compliance.yaml');
    expect(r.data['content']).toBe(yaml);
    expect(r.data['bytes']).toBe(Buffer.byteLength(yaml));
    expect(r.data['truncated']).toBe(false);
    expect(r.summary).toContain('lib/compliance.yaml');
  });

  it('normalises a leading ./ segment', async () => {
    await writeRoleFile('lib/obligations.yaml', 'due: []\n');
    const r = await executeReadRoleFile(roleHome, { path: './lib/obligations.yaml' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data['path']).toBe('lib/obligations.yaml');
  });

  it('allows a symlink that stays inside the role home on an allowed path', async () => {
    await writeRoleFile('lib/compliance.yaml', 'a: 1\n');
    await fs.symlink(
      path.join(roleHome, 'lib', 'compliance.yaml'),
      path.join(roleHome, 'lib', 'compliance-link.yaml'),
    );
    const r = await executeReadRoleFile(roleHome, { path: 'lib/compliance-link.yaml' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data['content']).toBe('a: 1\n');
  });
});

describe('executeReadRoleFile — allow list', () => {
  it.each([
    'persona.md',
    'CLAUDE.md',
    'lib/business-context.yaml',
    'verbs/account-read.md',
    'verbs/proposed/new-verb.md',
    'memory/people/mary-chen.md',
    'output/document/brief.md',
    'escalations/2026-09-29-ab12-help.md',
    'logs/2026-09-29.jsonl',
  ])('allows %s', async (rel) => {
    if (rel !== 'persona.md') await writeRoleFile(rel, `content of ${rel}\n`);
    const r = await executeReadRoleFile(roleHome, { path: rel });
    expect(r.ok).toBe(true);
  });

  it.each([
    'README.md',
    'docker-compose.yml',
    'campaigns/q3/plan.md',
    'dashboard/package.json',
    'notes.txt',
  ])('denies %s (not on the allow list)', async (rel) => {
    await writeRoleFile(rel, 'x\n');
    await expectRefusal(rel, /not on the read allow list/);
  });
});

describe('executeReadRoleFile — always-deny rules', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'lib/.env',
    'lib/.env.backup',
    '.tokens/google.json',
    'lib/.tokens/slack.json',
    '.git/config',
    'memory/.git/HEAD',
    'state/session.json',
    'lib/state/cursor.json',
    'lib/server.pem',
    'lib/tls.key',
    'lib/google-credentials.json',
    'lib/Credentials.yaml',
    'lib/credentials/aws.yaml',
    'lib/service-sa-key.json',
    'lib/id_rsa',
    'lib/id_ed25519.pub',
  ])('denies %s even though it may sit under an allowed prefix', async (rel) => {
    await writeRoleFile(rel, 'SECRET=1\n');
    await expectRefusal(rel, /secret|credential/i);
  });

  it('denies a symlink on an allowed path whose target is a denied file inside the role home', async () => {
    await writeRoleFile('.env', 'SECRET=1\n');
    await fs.mkdir(path.join(roleHome, 'lib'), { recursive: true });
    await fs.symlink(path.join(roleHome, '.env'), path.join(roleHome, 'lib', 'settings.yaml'));
    await expectRefusal('lib/settings.yaml', /secret|credential/i);
  });

  it('denies a symlink on an allowed path whose target is outside the allow list', async () => {
    await writeRoleFile('README.md', 'x\n');
    await fs.mkdir(path.join(roleHome, 'lib'), { recursive: true });
    await fs.symlink(path.join(roleHome, 'README.md'), path.join(roleHome, 'lib', 'readme.md'));
    await expectRefusal('lib/readme.md', /not on the read allow list/);
  });
});

describe('executeReadRoleFile — containment', () => {
  it('rejects `..` escapes', async () => {
    await fs.writeFile(path.join(tempDir, 'outside.txt'), 'nope\n', 'utf-8');
    await expectRefusal('../outside.txt', /unsafe path/);
  });

  it('rejects `..` segments even when they resolve back inside', async () => {
    await writeRoleFile('lib/compliance.yaml', 'a: 1\n');
    await expectRefusal('lib/../lib/compliance.yaml', /unsafe path/);
  });

  it('rejects absolute paths', async () => {
    await writeRoleFile('lib/compliance.yaml', 'a: 1\n');
    await expectRefusal(path.join(roleHome, 'lib', 'compliance.yaml'), /unsafe path/);
    await expectRefusal('/etc/passwd', /unsafe path/);
  });

  it('rejects null bytes', async () => {
    await expectRefusal('lib/a\u0000.yaml', /unsafe path/);
  });

  it('rejects a symlink whose realpath leaves the role home', async () => {
    const outside = path.join(tempDir, 'outside.yaml');
    await fs.writeFile(outside, 'secret: true\n', 'utf-8');
    await fs.mkdir(path.join(roleHome, 'lib'), { recursive: true });
    await fs.symlink(outside, path.join(roleHome, 'lib', 'escape.yaml'));
    await expectRefusal('lib/escape.yaml', /outside the role home/);
  });

  it('rejects a path through a symlinked directory that leaves the role home', async () => {
    const outsideDir = path.join(tempDir, 'elsewhere');
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'data.yaml'), 'x: 1\n', 'utf-8');
    await fs.symlink(outsideDir, path.join(roleHome, 'memory'));
    await expectRefusal('memory/data.yaml', /outside the role home/);
  });
});

describe('executeReadRoleFile — file-shape refusals', () => {
  it('refuses a missing file', async () => {
    await expectRefusal('lib/nope.yaml', /not found/);
  });

  it('refuses a directory', async () => {
    await fs.mkdir(path.join(roleHome, 'lib'), { recursive: true });
    await expectRefusal('lib', /directory/);
  });

  it('refuses a binary file', async () => {
    await writeRoleFile('output/document/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await expectRefusal('output/document/logo.png', /binary/);
  });

  it('refuses invalid input shape', async () => {
    const r = await executeReadRoleFile(roleHome, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/read_role_file input invalid/);
  });
});

describe('executeReadRoleFile — truncation', () => {
  it('caps content at READ_ROLE_FILE_MAX_BYTES with an explicit notice', async () => {
    const total = READ_ROLE_FILE_MAX_BYTES + 1000;
    await writeRoleFile('logs/big.jsonl', 'a'.repeat(total));

    const r = await executeReadRoleFile(roleHome, { path: 'logs/big.jsonl' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['truncated']).toBe(true);
    expect(r.data['bytes']).toBe(total);
    expect(r.data['returned_bytes']).toBe(READ_ROLE_FILE_MAX_BYTES);
    expect((r.data['content'] as string).length).toBe(READ_ROLE_FILE_MAX_BYTES);
    expect(r.data['notice']).toMatch(/truncated/i);
    expect(r.summary).toMatch(/truncated/i);
  });

  it('does not split a multi-byte character at the cap', async () => {
    // One ASCII byte shifts the 3-byte euro signs so the cap lands mid-char.
    const content = `a${'€'.repeat(READ_ROLE_FILE_MAX_BYTES / 3 + 10)}`;
    await writeRoleFile('memory/notes/euros.md', content);

    const r = await executeReadRoleFile(roleHome, { path: 'memory/notes/euros.md' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['truncated']).toBe(true);
    const text = r.data['content'] as string;
    expect(text).not.toContain('�');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(READ_ROLE_FILE_MAX_BYTES);
  });

  it('does not truncate a file exactly at the cap', async () => {
    await writeRoleFile('logs/exact.jsonl', 'b'.repeat(READ_ROLE_FILE_MAX_BYTES));
    const r = await executeReadRoleFile(roleHome, { path: 'logs/exact.jsonl' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data['truncated']).toBe(false);
  });
});
