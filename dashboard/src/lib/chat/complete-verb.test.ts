import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeCompleteVerb } from './complete-verb.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-complete-verb-'));
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

async function readTodayLogLines(now: Date): Promise<Record<string, unknown>[]> {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const file = path.join(tempDir, 'logs', `${yyyy}-${mm}-${dd}.jsonl`);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('executeCompleteVerb input validation', () => {
  it('refuses invalid slug shape', async () => {
    const r = await executeCompleteVerb(tempDir, {
      slug: 'NotKebab',
      outcome: 'success',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/complete_verb input invalid/);
  });

  it('refuses unknown outcome values', async () => {
    const r = await executeCompleteVerb(tempDir, {
      slug: 'account-read',
      outcome: 'mostly-fine',
    });
    expect(r.ok).toBe(false);
  });

  it('does not require a matching verb file to exist', async () => {
    // Operator might have renamed; a drafted verb body could have been used
    // inline. The recorder captures what the role tells it.
    const r = await executeCompleteVerb(tempDir, {
      slug: 'renamed-verb',
      outcome: 'success',
    });
    expect(r.ok).toBe(true);
  });
});

describe('executeCompleteVerb activity entry', () => {
  it('writes a verb_completed JSONL line on success', async () => {
    const now = new Date(2026, 4, 13, 9, 30, 15);
    const r = await executeCompleteVerb(
      tempDir,
      { slug: 'account-read', outcome: 'success' },
      now,
    );
    expect(r.ok).toBe(true);

    const lines = await readTodayLogLines(now);
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry['agent']).toBe('chat');
    expect(entry['action']).toBe('verb_completed');
    expect(entry['verb']).toBe('account-read');
    expect(entry['outcome']).toBe('success');
    expect(entry['headline']).toBe('done: account-read (success)');
    expect(entry['timestamp']).toMatch(/^2026-05-13T09:30:15[+-]\d{2}:\d{2}$/);
    // notes / produced are omitted when not supplied.
    expect(entry['notes']).toBeUndefined();
    expect(entry['produced']).toBeUndefined();
  });

  it('records each outcome value verbatim', async () => {
    const now = new Date(2026, 4, 13, 9, 30, 15);
    for (const outcome of ['success', 'partial', 'failed', 'skipped'] as const) {
      const r = await executeCompleteVerb(
        tempDir,
        { slug: 'account-read', outcome },
        now,
      );
      expect(r.ok).toBe(true);
    }
    const lines = await readTodayLogLines(now);
    expect(lines.map((l) => l['outcome'])).toEqual([
      'success',
      'partial',
      'failed',
      'skipped',
    ]);
    expect(lines.map((l) => l['headline'])).toEqual([
      'done: account-read (success)',
      'done: account-read (partial)',
      'done: account-read (failed)',
      'done: account-read (skipped)',
    ]);
  });

  it('carries notes through to the activity entry', async () => {
    const now = new Date(2026, 4, 13, 9, 30, 15);
    await executeCompleteVerb(
      tempDir,
      {
        slug: 'account-read',
        outcome: 'partial',
        notes: 'two of five accounts had no recent activity',
      },
      now,
    );
    const lines = await readTodayLogLines(now);
    expect(lines[0]!['notes']).toBe('two of five accounts had no recent activity');
  });

  it('carries produced artifacts through to the activity entry', async () => {
    const now = new Date(2026, 4, 13, 9, 30, 15);
    await executeCompleteVerb(
      tempDir,
      {
        slug: 'account-read',
        outcome: 'success',
        produced: ['output/record/account/acme/q1-read.md'],
      },
      now,
    );
    const lines = await readTodayLogLines(now);
    expect(lines[0]!['produced']).toEqual([
      'output/record/account/acme/q1-read.md',
    ]);
  });

  it('omits produced from the entry when the array is empty', async () => {
    const now = new Date(2026, 4, 13, 9, 30, 15);
    await executeCompleteVerb(
      tempDir,
      { slug: 'account-read', outcome: 'success', produced: [] },
      now,
    );
    const lines = await readTodayLogLines(now);
    expect(lines[0]!['produced']).toBeUndefined();
  });
});

describe('executeCompleteVerb commit shape', () => {
  it('commits the activity line as role(verb): complete <slug> — <outcome>', async () => {
    await initRepoWithBaseline();
    const now = new Date(2026, 4, 13, 9, 30, 15);
    const r = await executeCompleteVerb(
      tempDir,
      { slug: 'account-read', outcome: 'partial', notes: 'two stragglers' },
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect(r.summary).toMatch(/^completed verb account-read: partial · [0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s',
    ]);
    const [author, subject] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(verb): complete account-read — partial');
  });
});
