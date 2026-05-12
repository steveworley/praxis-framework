import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendTurn,
  createThread,
  deleteThread,
  deriveTitle,
  generateThreadId,
  listThreads,
  loadThread,
  parseThreadFile,
} from './conversation.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-conversation-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('deriveTitle', () => {
  it("falls back to 'New chat' for empty input", () => {
    expect(deriveTitle('')).toBe('New chat');
    expect(deriveTitle('   ')).toBe('New chat');
  });

  it('keeps the first ~8 words as the title', () => {
    expect(deriveTitle('How did the acme account go this week, anything to flag?')).toBe(
      'How did the acme account go this week,',
    );
  });

  it('collapses whitespace', () => {
    expect(deriveTitle('one  two\nthree')).toBe('one two three');
  });
});

describe('generateThreadId', () => {
  it('is sortable by date prefix + has a random suffix', () => {
    const a = generateThreadId(new Date('2026-05-12T10:00:00Z'));
    const b = generateThreadId(new Date('2026-05-13T10:00:00Z'));
    expect(a.startsWith('2026-05-12-')).toBe(true);
    expect(b.startsWith('2026-05-13-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('createThread', () => {
  it('writes a file with frontmatter and the first user turn', async () => {
    const { thread_id } = await createThread(tempDir, 'What did you do this week?');
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    const text = await fs.readFile(filePath, 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain(`thread_id: ${thread_id}`);
    expect(text).toMatch(/title: What did you do this week\?/);
    expect(text).toMatch(/^## User · /m);
    expect(text).toContain('What did you do this week?');
  });

  it('returns a derived title', async () => {
    const result = await createThread(tempDir, 'hello there');
    expect(result.title).toBe('hello there');
  });
});

describe('appendTurn + loadThread round-trip', () => {
  it('appends both user and assistant turns and preserves them in order', async () => {
    const { thread_id } = await createThread(tempDir, 'first message');
    await appendTurn(tempDir, thread_id, { role: 'assistant', content: 'first reply' });
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'second message' });
    await appendTurn(tempDir, thread_id, {
      role: 'assistant',
      content: 'second reply\n\nwith multiple paragraphs',
    });

    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.thread.thread_id).toBe(thread_id);
    expect(loaded.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(loaded.turns[0]!.content).toBe('first message');
    expect(loaded.turns[1]!.content).toBe('first reply');
    expect(loaded.turns[2]!.content).toBe('second message');
    expect(loaded.turns[3]!.content).toBe('second reply\n\nwith multiple paragraphs');
  });

  it('bumps the updated timestamp on append', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
      const { thread_id } = await createThread(tempDir, 'hello');
      vi.setSystemTime(new Date('2026-05-12T10:05:00Z'));
      await appendTurn(tempDir, thread_id, { role: 'assistant', content: 'hi' });
      const loaded = await loadThread(tempDir, thread_id);
      expect(loaded.thread.created).toBe('2026-05-12T10:00:00Z');
      expect(loaded.thread.updated).toBe('2026-05-12T10:05:00Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listThreads', () => {
  it('returns an empty list when memory/conversations/ does not exist', async () => {
    const summaries = await listThreads(tempDir);
    expect(summaries).toEqual([]);
  });

  it('returns threads sorted by updated desc', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-10T10:00:00Z'));
      const a = await createThread(tempDir, 'oldest');
      vi.setSystemTime(new Date('2026-05-11T10:00:00Z'));
      const b = await createThread(tempDir, 'middle');
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
      const c = await createThread(tempDir, 'newest');

      const summaries = await listThreads(tempDir);
      expect(summaries.map((s) => s.thread_id)).toEqual([c.thread_id, b.thread_id, a.thread_id]);
      expect(summaries[0]!.message_count).toBe(1);
      expect(summaries[0]!.last_user_message).toBe('newest');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips malformed thread files with a warning', async () => {
    const convDir = path.join(tempDir, 'memory', 'conversations');
    await fs.mkdir(convDir, { recursive: true });
    await fs.writeFile(path.join(convDir, 'broken.md'), 'no frontmatter here\n', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summaries = await listThreads(tempDir);
    expect(summaries).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('deleteThread', () => {
  it('removes the thread file', async () => {
    const { thread_id } = await createThread(tempDir, 'gone soon');
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    await deleteThread(tempDir, thread_id);
    await expect(fs.access(filePath)).rejects.toBeTruthy();
  });
});

describe('parseThreadFile', () => {
  it('returns null on missing frontmatter', () => {
    expect(parseThreadFile('## User · 2026-05-12\n\nhi\n')).toBeNull();
  });

  it('returns null when required frontmatter fields are missing', () => {
    expect(
      parseThreadFile('---\nthread_id: abc\n---\n\n## User · 2026-05-12T10:00:00Z\n\nhi\n'),
    ).toBeNull();
  });
});

describe('thread_id safety', () => {
  it('rejects path traversal in loadThread', async () => {
    await expect(loadThread(tempDir, '../etc/passwd')).rejects.toThrow(/Invalid thread_id/);
  });

  it('rejects path traversal in appendTurn', async () => {
    await expect(
      appendTurn(tempDir, '../etc/passwd', { role: 'user', content: 'x' }),
    ).rejects.toThrow(/Invalid thread_id/);
  });
});
