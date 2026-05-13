import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createSpy = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class Anthropic {
    messages: { create: typeof createSpy };
    constructor(_opts: unknown) {
      this.messages = { create: createSpy };
    }
    static APIError = APIError;
  }
  return { default: Anthropic, APIError };
});

let tempDir: string;
let prevKey: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-summarise-'));
  prevKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  createSpy.mockReset();
});

afterEach(async () => {
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  await fs.rm(tempDir, { recursive: true, force: true });
});

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
    '--allow-empty',
    '-m',
    'init',
  ]);
}

async function seedThread(threadId: string, turns: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>): Promise<void> {
  const dir = path.join(tempDir, 'memory', 'conversations');
  await fs.mkdir(dir, { recursive: true });
  const fm = [
    '---',
    `thread_id: ${threadId}`,
    'title: Test thread',
    'created: 2026-05-01T10:00:00Z',
    'updated: 2026-05-13T10:00:00Z',
    '---',
  ].join('\n');
  const body = turns
    .map((t) => {
      const heading = t.role === 'user' ? 'User' : 'Assistant';
      return `## ${heading} · ${t.timestamp}\n\n${t.content}`;
    })
    .join('\n\n');
  await fs.writeFile(path.join(dir, `${threadId}.md`), `${fm}\n\n${body}\n`, 'utf-8');
}

function mockSummaryResponse(text: string): void {
  createSpy.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  });
}

describe('summariseThread refusals', () => {
  it('refuses an empty thread', async () => {
    const { summariseThread } = await import('./summarise.ts');
    await seedThread('thread-empty', []);
    const r = await summariseThread(tempDir, 'thread-empty');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has only 0 turn/);
  });

  it('refuses a single-turn thread', async () => {
    const { summariseThread } = await import('./summarise.ts');
    await seedThread('thread-1', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'hello' },
    ]);
    const r = await summariseThread(tempDir, 'thread-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has only 1 turn/);
  });

  it('refuses a 3-turn thread (below the minimum of 4)', async () => {
    const { summariseThread } = await import('./summarise.ts');
    await seedThread('thread-3', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'a' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'b' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'c' },
    ]);
    const r = await summariseThread(tempDir, 'thread-3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has only 3 turn/);
  });

  it('refuses a missing thread cleanly', async () => {
    const { summariseThread } = await import('./summarise.ts');
    const r = await summariseThread(tempDir, 'no-such-thread');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/could not be loaded/);
  });
});

describe('summariseThread happy path', () => {
  it('summarises a 4-turn thread: archives older 2, preserves newer 2', async () => {
    const { summariseThread } = await import('./summarise.ts');
    const { loadThread } = await import('./conversation.ts');
    mockSummaryResponse('- The operator asked about Q1 numbers.\n- The role committed to a follow-up.');

    await initRepoWithBaseline();
    await seedThread('thread-4', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'first user message' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'first reply' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'newest user message' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'newest reply' },
    ]);

    const r = await summariseThread(tempDir, 'thread-4', {
      now: new Date('2026-05-13T11:00:00Z'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Older turns moved to archive (2 of 4, since floor(4 * 0.7) = 2).
    expect(r.turnRange).toEqual({ from: 1, to: 2 });
    expect(r.archivedPath).toMatch(/^memory\/conversations\/archived\/thread-4-turns-1-2-/);
    const archivedAbs = path.join(tempDir, r.archivedPath);
    const archivedText = await fs.readFile(archivedAbs, 'utf-8');
    expect(archivedText).toContain('archived_from: thread-4');
    expect(archivedText).toContain('turn_range: 1-2');
    expect(archivedText).toContain('first user message');
    expect(archivedText).toContain('first reply');
    expect(archivedText).not.toContain('newest user message');

    // Thread file: has summary block + newest 2 turns.
    const reloaded = await loadThread(tempDir, 'thread-4');
    expect(reloaded.turns).toHaveLength(3); // summary + 2 verbatim
    expect(reloaded.turns[0]!.role).toBe('summary');
    expect(reloaded.turns[0]!.summaryRange).toEqual({ from: 1, to: 2 });
    expect(reloaded.turns[0]!.content).toMatch(/operator asked about Q1/);
    expect(reloaded.turns[1]!.role).toBe('user');
    expect(reloaded.turns[1]!.content).toBe('newest user message');
    expect(reloaded.turns[2]!.role).toBe('assistant');
    expect(reloaded.turns[2]!.content).toBe('newest reply');

    // Token estimates are tracked; assertion that they shrink lives in a
    // larger-thread test below where the summary is genuinely shorter than
    // the originals.
    expect(typeof r.tokensAfter).toBe('number');
    expect(typeof r.tokensBefore).toBe('number');
  });

  it('reduces the token estimate on a thread where the originals dwarf the summary', async () => {
    const { summariseThread } = await import('./summarise.ts');
    // Mock a short summary.
    mockSummaryResponse('- brief summary');

    await initRepoWithBaseline();
    const longBody = 'a '.repeat(500); // ~1000 chars → ~250 tokens per turn
    await seedThread('thread-long', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: longBody },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: longBody },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: longBody },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'newest' },
    ]);
    const r = await summariseThread(tempDir, 'thread-long');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
  });

  it('lands a single role-attributed audit commit covering both files', async () => {
    const { summariseThread } = await import('./summarise.ts');
    mockSummaryResponse('- Operator and role discussed the account.');

    await initRepoWithBaseline();
    await seedThread('thread-audit', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'first' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'second' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'third' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'fourth' },
    ]);
    // The thread file was created after the baseline init commit, so it's
    // currently untracked — commit it explicitly so the audit commit lands
    // a true content rewrite (not just an "add new file") pair.
    const git = simpleGit(tempDir);
    await git.add('memory/conversations/thread-audit.md');
    await git.raw([
      '-c',
      'user.name=Operator',
      '-c',
      'user.email=op@example.test',
      'commit',
      '--author=Operator <op@example.test>',
      '--no-gpg-sign',
      '-m',
      'seed thread for test',
    ]);

    const r = await summariseThread(tempDir, 'thread-audit');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commitSha).toBeDefined();

    const log = await git.log({ maxCount: 1 });
    const head = log.latest!;
    expect(head.message).toContain('role(conversation): summarise thread-audit turns 1-2');
    expect(head.author_name).toBe('Praxis Role');
    expect(head.author_email).toBe('role@praxis.local');

    // The commit touches both the thread file and the new archived file.
    const filesInHead = await git.raw([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      head.hash,
    ]);
    const touched = filesInHead.split('\n').filter((l) => l.length > 0);
    expect(touched.some((f) => f === 'memory/conversations/thread-audit.md')).toBe(true);
    expect(touched.some((f) => f.startsWith('memory/conversations/archived/thread-audit-turns-1-2-'))).toBe(true);
  });

  it('git revert on the summarise commit restores the thread to pre-summarise state', async () => {
    const { summariseThread } = await import('./summarise.ts');
    mockSummaryResponse('- A faithful summary.');

    await initRepoWithBaseline();
    await seedThread('thread-revert', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'first' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'second' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'third' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'fourth' },
    ]);
    const git = simpleGit(tempDir);
    await git.add('memory/conversations/thread-revert.md');
    await git.raw([
      '-c',
      'user.name=Operator',
      '-c',
      'user.email=op@example.test',
      'commit',
      '--author=Operator <op@example.test>',
      '--no-gpg-sign',
      '-m',
      'seed thread',
    ]);
    const preSummariseContent = await fs.readFile(
      path.join(tempDir, 'memory/conversations/thread-revert.md'),
      'utf-8',
    );

    const r = await summariseThread(tempDir, 'thread-revert');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Revert the audit commit.
    await git.raw([
      '-c',
      'user.name=Operator',
      '-c',
      'user.email=op@example.test',
      'revert',
      '--no-edit',
      '--no-gpg-sign',
      'HEAD',
    ]);

    const restored = await fs.readFile(
      path.join(tempDir, 'memory/conversations/thread-revert.md'),
      'utf-8',
    );
    expect(restored).toBe(preSummariseContent);

    // The archived file is also gone after revert.
    const archivedDir = path.join(tempDir, 'memory', 'conversations', 'archived');
    const entries = await fs.readdir(archivedDir).catch(() => [] as string[]);
    expect(entries.filter((e) => e.startsWith('thread-revert-'))).toHaveLength(0);
  });

  it('re-summarising a thread folds the prior summary into the new one', async () => {
    const { summariseThread } = await import('./summarise.ts');
    const { loadThread } = await import('./conversation.ts');

    await initRepoWithBaseline();
    await seedThread('thread-twice', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'first' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'second' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'third' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'fourth' },
      { role: 'user', timestamp: '2026-05-13T10:04:00Z', content: 'fifth' },
      { role: 'assistant', timestamp: '2026-05-13T10:05:00Z', content: 'sixth' },
    ]);

    // First summarise call.
    mockSummaryResponse('- First-pass summary covering turns 1-4.');
    const first = await summariseThread(tempDir, 'thread-twice', {
      now: new Date('2026-05-13T11:00:00Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 6 turns, floor(6 * 0.7) = 4 folded; 2 newer preserved.
    expect(first.turnRange).toEqual({ from: 1, to: 4 });

    // Now add a couple more turns to push the thread back over a re-summarise threshold.
    const { appendTurn } = await import('./conversation.ts');
    await appendTurn(tempDir, 'thread-twice', {
      role: 'user',
      content: 'seventh',
      timestamp: '2026-05-13T12:00:00Z',
    });
    await appendTurn(tempDir, 'thread-twice', {
      role: 'assistant',
      content: 'eighth',
      timestamp: '2026-05-13T12:01:00Z',
    });

    // Reload and confirm there are now 5 effective turns (summary + 2 + 2).
    const mid = await loadThread(tempDir, 'thread-twice');
    expect(mid.turns).toHaveLength(5);
    expect(mid.turns[0]!.role).toBe('summary');

    // Capture the user-message content the model receives so we can assert
    // the prior summary travels along.
    mockSummaryResponse('- Second-pass summary including the prior summary.');
    const second = await summariseThread(tempDir, 'thread-twice', {
      now: new Date('2026-05-13T13:00:00Z'),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // The mock's most recent call should have included the prior summary
    // block in the transcript it received.
    const lastCall = createSpy.mock.calls[createSpy.mock.calls.length - 1]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPayload = lastCall.messages[0]!.content;
    expect(userPayload).toContain('First-pass summary covering turns 1-4');

    const reloaded = await loadThread(tempDir, 'thread-twice');
    // 5 turns folded (the summary + first 3 of the 4 newer ones), 2 preserved.
    // floor(5 * 0.7) = 3, so the older 3 fold and 2 stay verbatim — and the
    // summary turn lands as turn[0] of the rewrite.
    expect(reloaded.turns[0]!.role).toBe('summary');
    expect(reloaded.turns[0]!.content).toMatch(/Second-pass summary/);
  });
});

describe('summariseThread Anthropic failure modes', () => {
  it('returns a clean failure when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { summariseThread } = await import('./summarise.ts');
    await seedThread('thread-4', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'a' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'b' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'c' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'd' },
    ]);
    const r = await summariseThread(tempDir, 'thread-4');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns a clean failure when Anthropic returns an empty summary', async () => {
    const { summariseThread } = await import('./summarise.ts');
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
    });
    await seedThread('thread-empty-summary', [
      { role: 'user', timestamp: '2026-05-13T10:00:00Z', content: 'a' },
      { role: 'assistant', timestamp: '2026-05-13T10:01:00Z', content: 'b' },
      { role: 'user', timestamp: '2026-05-13T10:02:00Z', content: 'c' },
      { role: 'assistant', timestamp: '2026-05-13T10:03:00Z', content: 'd' },
    ]);
    const r = await summariseThread(tempDir, 'thread-empty-summary');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty summary/i);
  });
});
