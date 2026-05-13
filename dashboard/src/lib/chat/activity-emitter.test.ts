import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emitToolActivity } from './activity-emitter.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-activity-emit-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function initRepoWithBaseline(): Promise<void> {
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.name', 'Operator', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await git.add('persona.md');
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

describe('emitToolActivity', () => {
  it('writes a JSONL entry with the conventional fields', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'write_memory',
      { path: 'memory/people/mary.md', created: '2026-05-12' },
      now,
    );

    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const line = file.trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['agent']).toBe('chat');
    expect(parsed['action']).toBe('tool_call');
    expect(parsed['tool']).toBe('write_memory');
    expect(parsed['path']).toBe('memory/people/mary.md');
    expect(parsed['created']).toBe('2026-05-12');
    expect(parsed['timestamp']).toMatch(/^2026-05-12T09:30:15[+-]\d{2}:\d{2}$/);
  });

  it('appends to existing logs rather than overwriting (idempotent file growth)', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(tempDir, 'write_memory', { path: 'a' }, now);
    await emitToolActivity(tempDir, 'create_escalation', { path: 'b' }, now);

    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const lines = file.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first['tool']).toBe('write_memory');
    expect(second['tool']).toBe('create_escalation');
  });

  it('refuses to shadow conventional fields supplied in payload', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'write_memory',
      {
        // Caller accidentally supplied a duplicate `agent` / `action` — the
        // emitter must keep the canonical values it stamped.
        agent: 'evil',
        action: 'evil',
        tool: 'evil',
        path: 'memory/people/x.md',
      },
      now,
    );
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed['agent']).toBe('chat');
    expect(parsed['action']).toBe('tool_call');
    expect(parsed['tool']).toBe('write_memory');
    expect(parsed['path']).toBe('memory/people/x.md');
  });

  it('commits the appended line as role(activity): log tool_call <name>', async () => {
    await initRepoWithBaseline();
    const now = new Date(2026, 4, 12, 9, 30, 15);
    const commit = await emitToolActivity(
      tempDir,
      'write_memory',
      { path: 'memory/people/mary.md' },
      now,
    );
    expect(commit.committed).toBe(true);
    expect(typeof commit.sha).toBe('string');
    expect(commit.shortSha).toMatch(/^[0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s',
    ]);
    const [author, subject] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(activity): log tool_call write_memory');
  });

  it('creates the logs directory if it does not yet exist', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(tempDir, 'write_memory', { path: 'x' }, now);
    const stat = await fs.stat(path.join(tempDir, 'logs'));
    expect(stat.isDirectory()).toBe(true);
  });
});
