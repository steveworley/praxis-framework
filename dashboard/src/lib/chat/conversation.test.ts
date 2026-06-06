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
  serializeTurn,
  type Turn,
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
  it('writes a file with frontmatter only — no turns yet', async () => {
    const { thread_id } = await createThread(tempDir, 'What did you do this week?');
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    const text = await fs.readFile(filePath, 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain(`thread_id: ${thread_id}`);
    expect(text).toMatch(/title: What did you do this week\?/);
    // Title is derived from firstMessage, but the message itself is not
    // persisted as a turn — appendTurn is the single source of truth.
    expect(text).not.toMatch(/^## User · /m);
    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toEqual([]);
  });

  it('returns a derived title', async () => {
    const result = await createThread(tempDir, 'hello there');
    expect(result.title).toBe('hello there');
  });

  it('does not duplicate the user turn when appendTurn is called with the same content', async () => {
    // Regression: createThread used to write the first user turn itself, and
    // the chat frontend then POSTed to /api/chat/message which appended the
    // same turn again. Now createThread writes frontmatter only and appendTurn
    // is the single source of truth.
    const { thread_id } = await createThread(tempDir, 'hello');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'hello' });
    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0]!.role).toBe('user');
    expect(loaded.turns[0]!.content).toBe('hello');
  });
});

describe('appendTurn + loadThread round-trip', () => {
  it('appends both user and assistant turns and preserves them in order', async () => {
    const { thread_id } = await createThread(tempDir, 'first message');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'first message' });
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
      await appendTurn(tempDir, a.thread_id, { role: 'user', content: 'oldest' });
      vi.setSystemTime(new Date('2026-05-11T10:00:00Z'));
      const b = await createThread(tempDir, 'middle');
      await appendTurn(tempDir, b.thread_id, { role: 'user', content: 'middle' });
      vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
      const c = await createThread(tempDir, 'newest');
      await appendTurn(tempDir, c.thread_id, { role: 'user', content: 'newest' });

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

describe('tool calls round-trip', () => {
  it('persists toolCalls on an assistant turn and parses them back', async () => {
    const { thread_id } = await createThread(tempDir, 'first');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'first' });
    await appendTurn(tempDir, thread_id, {
      role: 'assistant',
      content: 'I noted that down.',
      toolCalls: [
        {
          name: 'write_memory',
          input: { category: 'people', title: 'Mary', body: 'b' },
          result: {
            ok: true,
            summary: 'wrote memory/people/mary.md',
            data: { path: 'memory/people/mary.md' },
          },
        },
      ],
    });

    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toHaveLength(2);
    const assistant = loaded.turns[1]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('I noted that down.');
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]?.name).toBe('write_memory');
    expect(assistant.toolCalls?.[0]?.result.ok).toBe(true);

    // The on-disk fence should be present in the rendered file.
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    const text = await fs.readFile(filePath, 'utf-8');
    expect(text).toContain('<!-- praxis:tool_calls');
    expect(text).toContain('-->');
  });

  it('survives a malformed fence by falling back to no tool calls', async () => {
    const { thread_id } = await createThread(tempDir, 'x');
    // Hand-craft a thread file with a broken JSON fence to verify the
    // fail-safe path: we still parse the turn, just without toolCalls.
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    const broken = [
      '---',
      `thread_id: ${thread_id}`,
      'title: x',
      'created: 2026-05-12T10:00:00Z',
      'updated: 2026-05-12T10:00:00Z',
      '---',
      '',
      '## Assistant · 2026-05-12T10:00:00Z',
      '',
      '<!-- praxis:tool_calls',
      'this is not json',
      '-->',
      '',
      'Body text.',
      '',
    ].join('\n');
    await fs.writeFile(filePath, broken, 'utf-8');
    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0]!.toolCalls).toBeUndefined();
    // The fence stays as part of the content when JSON parse fails — that's
    // acceptable; the alternative (silently dropping content) would be worse.
  });
});

describe('summary turn round-trip', () => {
  it('parses a `## Summary · turns N-M · <iso>` block as a synthetic summary turn', async () => {
    const { thread_id } = await createThread(tempDir, 'x');
    // Hand-craft a thread file containing a Summary block + a verbatim newer
    // turn, matching the on-disk shape `summariseThread` produces.
    const filePath = path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`);
    const body = [
      '---',
      `thread_id: ${thread_id}`,
      'title: x',
      'created: 2026-05-12T10:00:00Z',
      'updated: 2026-05-13T11:00:00Z',
      '---',
      '',
      '## Summary · turns 1-4 · 2026-05-13T11:00:00Z',
      '',
      '- The operator asked about Q1 numbers.',
      '- The role committed to a follow-up.',
      '',
      '## User · 2026-05-13T12:00:00Z',
      '',
      'newest message',
      '',
    ].join('\n');
    await fs.writeFile(filePath, body, 'utf-8');

    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toHaveLength(2);
    expect(loaded.turns[0]!.role).toBe('summary');
    expect(loaded.turns[0]!.timestamp).toBe('2026-05-13T11:00:00Z');
    expect(loaded.turns[0]!.summaryRange).toEqual({ from: 1, to: 4 });
    expect(loaded.turns[0]!.content).toContain('operator asked about Q1');
    expect(loaded.turns[1]!.role).toBe('user');
    expect(loaded.turns[1]!.content).toBe('newest message');
  });
});

describe('serializeTurn', () => {
  it('renders content_html and an empty workProducts list when no tool calls', () => {
    const turn: Turn = { role: 'assistant', timestamp: '2026-06-06T10:00:00Z', content: 'hello' };
    const out = serializeTurn(turn);
    expect(out.content_html).toContain('hello');
    expect(out.workProducts).toEqual([]);
  });

  it('includes a workProduct chip for a successful write_output call', () => {
    const turn: Turn = {
      role: 'assistant',
      timestamp: '2026-06-06T10:00:00Z',
      content: 'Wrote the brief.',
      toolCalls: [
        {
          name: 'write_output',
          input: {},
          result: { ok: true, data: { path: 'output/document/q1-brief.md', type: 'document', slug: 'q1-brief', status: 'draft' } },
        },
      ],
    };
    const out = serializeTurn(turn);
    expect(out.workProducts).toEqual([
      { type: 'document', slug: 'q1-brief', href: '/output/document/q1-brief', label: 'document · q1-brief' },
    ]);
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
