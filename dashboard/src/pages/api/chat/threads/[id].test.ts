import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendTurn, createThread } from '@/lib/chat/conversation.ts';

import { DELETE, GET } from './[id].ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-thread-id-'));
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callGet(id: string): Promise<Response> {
  return Promise.resolve(
    GET({ params: { id } } as unknown as Parameters<typeof GET>[0]) as Response | Promise<Response>,
  );
}

function callDelete(id: string): Promise<Response> {
  return Promise.resolve(
    DELETE({ params: { id } } as unknown as Parameters<typeof DELETE>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('GET /api/chat/threads/[id]', () => {
  it('returns 404 when the thread does not exist', async () => {
    const res = await callGet('2026-05-12-deadbeef');
    expect(res.status).toBe(404);
  });

  it('returns the thread detail when present', async () => {
    const { thread_id } = await createThread(tempDir, 'hello there');
    // The first user turn is appended explicitly — createThread writes
    // frontmatter only so /api/chat/message owns turn persistence.
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'hello there' });
    const res = await callGet(thread_id);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      thread: { thread_id: string; title: string };
      turns: Array<{ role: string; content: string; content_html: string }>;
    };
    expect(payload.thread.thread_id).toBe(thread_id);
    expect(payload.thread.title).toBe('hello there');
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]!.role).toBe('user');
    expect(payload.turns[0]!.content).toBe('hello there');
    // Markdown is rendered server-side so the chat client doesn't have to
    // ship markdown-it. The body becomes a wrapped <p> via markdown-it.
    expect(payload.turns[0]!.content_html).toBe('<p>hello there</p>\n');
  });

  it('renders markdown turns server-side into content_html', async () => {
    const { thread_id } = await createThread(tempDir, 'rich');
    await appendTurn(tempDir, thread_id, {
      role: 'assistant',
      content: '## Heading\n\n- one\n- two\n\n> a quote',
    });
    const res = await callGet(thread_id);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      turns: Array<{ content_html: string }>;
    };
    const html = payload.turns[0]!.content_html;
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>');
  });

  it('returns 400 on invalid thread id (path traversal)', async () => {
    const res = await callGet('../etc/passwd');
    expect([400, 500]).toContain(res.status);
  });
});

describe('DELETE /api/chat/threads/[id]', () => {
  it('removes the thread file', async () => {
    const { thread_id } = await createThread(tempDir, 'soon to be gone');
    const res = await callDelete(thread_id);
    expect(res.status).toBe(200);
    await expect(
      fs.access(path.join(tempDir, 'memory', 'conversations', `${thread_id}.md`)),
    ).rejects.toBeTruthy();
  });

  it('returns 404 when deleting a non-existent thread', async () => {
    const res = await callDelete('2026-05-12-deadbeef');
    expect(res.status).toBe(404);
  });
});
