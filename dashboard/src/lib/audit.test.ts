import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitChange } from './audit.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-audit-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Set a local git identity inside `dir` so test repos don't depend on the
 * host's git config. Mirrors the helper in autonomy-loader.test.ts.
 */
async function configureLocalIdentity(
  dir: string,
  name: string,
  email: string,
): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig('user.name', name, false, 'local');
  await git.addConfig('user.email', email, false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
}

async function initRepo(dir: string, name = 'Operator', email = 'op@example.test'): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await configureLocalIdentity(dir, name, email);
  // Plant an initial commit so HEAD exists.
  await fs.writeFile(path.join(dir, 'persona.md'), '# Persona\n', 'utf-8');
  await git.add('persona.md');
  await git.raw([
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    '-c',
    'commit.gpgsign=false',
    'commit',
    `--author=${name} <${email}>`,
    '--no-gpg-sign',
    '-m',
    'init',
  ]);
}

async function writeAndCommit(rel: string, body: string): Promise<void> {
  const abs = path.join(tempDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

async function lastCommit(
  dir: string,
): Promise<{ sha: string; author: string; subject: string; body: string }> {
  const git = simpleGit(dir);
  const raw = await git.raw(['log', '-n', '1', '--pretty=format:%H%x1f%an <%ae>%x1f%s%x1f%b']);
  const parts = raw.split('\x1f');
  return {
    sha: parts[0] ?? '',
    author: parts[1] ?? '',
    subject: parts[2] ?? '',
    body: parts[3] ?? '',
  };
}

describe('commitChange (audit)', () => {
  it('returns a warning when no paths are supplied', async () => {
    await initRepo(tempDir);
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: [],
      scope: 'memory',
      subject: 'note',
    });
    expect(result.committed).toBe(false);
    expect(result.warning).toMatch(/no paths/i);
  });

  it('commits a role-attributed change for an existing repo', async () => {
    await initRepo(tempDir);
    await writeAndCommit('memory/notes/foo.md', '# foo\n');
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo',
      body: 'Category: notes',
    });
    expect(result.committed).toBe(true);
    expect(result.sha?.length).toBeGreaterThan(0);
    expect(result.shortSha?.length).toBe(7);

    const head = await lastCommit(tempDir);
    expect(head.sha).toBe(result.sha);
    expect(head.subject).toBe('role(memory): note foo');
    expect(head.author).toBe('Praxis Role <role@praxis.local>');
    expect(head.body).toContain('Category: notes');
  });

  it('commits an operator-attributed change using the repo git identity', async () => {
    await initRepo(tempDir, 'Alex Operator', 'alex@example.test');
    await writeAndCommit('escalations/2026-05-01-x.md', 'updated\n');
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'operator',
      filePaths: ['escalations/2026-05-01-x.md'],
      scope: 'triage',
      subject: 'accept escalation 2026-05-01-x',
    });
    expect(result.committed).toBe(true);
    const head = await lastCommit(tempDir);
    expect(head.subject).toBe('operator(triage): accept escalation 2026-05-01-x');
    expect(head.author).toBe('Alex Operator <alex@example.test>');
  });

  it('returns committed:false with a no-changes warning when staged diff is empty', async () => {
    await initRepo(tempDir);
    await writeAndCommit('memory/notes/foo.md', 'identical\n');
    // First commit: should land.
    const first = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo',
    });
    expect(first.committed).toBe(true);

    // Second call with the same file content: no diff, should skip cleanly.
    const second = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo again',
    });
    expect(second.committed).toBe(false);
    expect(second.warning).toMatch(/no changes/i);
  });

  it('stages only the named paths, leaving operator-staged work in flight alone', async () => {
    await initRepo(tempDir);
    // Operator has an unrelated edit staged in flight.
    await writeAndCommit('README.md', 'operator wip\n');
    const git = simpleGit(tempDir);
    await git.add('README.md');

    // Role writes a memory note.
    await writeAndCommit('memory/notes/foo.md', '# foo\n');
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo',
    });
    expect(result.committed).toBe(true);

    const head = await lastCommit(tempDir);
    // The operator's README change is NOT in this commit — it's still staged
    // and uncommitted.
    const diffTree = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', head.sha]);
    const files = diffTree.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(files).toEqual(['memory/notes/foo.md']);

    // README.md should still be staged (not committed).
    const status = await git.status();
    expect(status.staged).toContain('README.md');
  });

  it('auto-inits a git repo and lays a baseline commit when none exists', async () => {
    // Drop a file but don't `git init`.
    await writeAndCommit('persona.md', '# Persona\n');
    await writeAndCommit('memory/notes/foo.md', '# foo\n');

    // The audit module will need to read operator identity from a config that
    // does not yet exist; we set an env-level shim via local config after init
    // is implicit. To mimic a normal operator with global git config, we set
    // local config *after* commitChange — but commitChange does the init
    // itself. So we need a way to ensure baseline commit has a usable
    // identity. Without GIT_AUTHOR/COMMITTER env, the synthetic Operator
    // fallback kicks in. That's the contract.
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo',
    });
    expect(result.committed).toBe(true);

    const git = simpleGit(tempDir);
    expect(await git.checkIsRepo()).toBe(true);

    const log = await git.raw(['log', '--pretty=format:%s']);
    const subjects = log.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(subjects).toEqual(['role(memory): note foo', 'chore: praxis init audit baseline']);
  });

  it('attributes operator commit to the synthetic Operator when no git identity is set', async () => {
    // Init a repo but leave user.name/email unset. We need to prevent git
    // from reading the host's global ~/.gitconfig and the system one so the
    // resolution genuinely sees "no identity"; point GIT_CONFIG_GLOBAL at
    // /dev/null and set GIT_CONFIG_NOSYSTEM=1 for the duration of the test.
    const prevGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const prevNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      const git = simpleGit(tempDir);
      await git.init();
      await git.addConfig('commit.gpgsign', 'false', false, 'local');
      // Plant initial commit using inline `-c` identity so we don't depend on
      // global config (which the env override is hiding anyway).
      await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
      await git.add('persona.md');
      await git.raw([
        '-c',
        'user.name=Bootstrap',
        '-c',
        'user.email=boot@example.test',
        'commit',
        '--author=Bootstrap <boot@example.test>',
        '--no-gpg-sign',
        '-m',
        'init',
      ]);

      await writeAndCommit('escalations/2026-05-01-x.md', 'updated\n');
      const result = await commitChange({
        roleHome: tempDir,
        actor: 'operator',
        filePaths: ['escalations/2026-05-01-x.md'],
        scope: 'triage',
        subject: 'accept escalation 2026-05-01-x',
      });
      expect(result.committed).toBe(true);
      expect(result.warning).toMatch(/operator git identity is not set/i);
      const head = await lastCommit(tempDir);
      expect(head.author).toBe('Operator <operator@praxis.local>');
    } finally {
      if (prevGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = prevGlobal;
      if (prevNoSystem === undefined) delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = prevNoSystem;
    }
  });

  it('honors a custom type when provided', async () => {
    await initRepo(tempDir);
    await writeAndCommit('memory/notes/foo.md', '# foo\n');
    const result = await commitChange({
      roleHome: tempDir,
      actor: 'role',
      type: 'feat',
      filePaths: ['memory/notes/foo.md'],
      scope: 'memory',
      subject: 'note foo',
    });
    expect(result.committed).toBe(true);
    const head = await lastCommit(tempDir);
    expect(head.subject).toBe('feat(memory): note foo');
  });
});
