import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET, POST } from './threads.ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-threads-'));
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callGet(): Promise<Response> {
  return Promise.resolve(GET({} as Parameters<typeof GET>[0]) as Response | Promise<Response>);
}

function callPost(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/chat/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    POST({ request } as unknown as Parameters<typeof POST>[0]) as Response | Promise<Response>,
  );
}

describe('GET /api/chat/threads', () => {
  it('returns an empty list when no threads exist', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ threads: [] });
  });
});

describe('POST /api/chat/threads', () => {
  it('rejects invalid JSON with 400', async () => {
    const res = await callPost('not-json');
    expect(res.status).toBe(400);
  });

  it('rejects an empty first_message with 422', async () => {
    const res = await callPost({ first_message: '   ' });
    expect(res.status).toBe(422);
  });

  it('creates a thread and returns the id + title', async () => {
    const res = await callPost({ first_message: 'how did the acme account go?' });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { thread_id: string; title: string };
    expect(payload.thread_id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]+$/);
    expect(payload.title).toBe('how did the acme account go?');

    // Verify the file actually landed.
    const filePath = path.join(tempDir, 'memory', 'conversations', `${payload.thread_id}.md`);
    const text = await fs.readFile(filePath, 'utf-8');
    expect(text).toContain('how did the acme account go?');
  });

  it('shows new threads in the subsequent GET response', async () => {
    await callPost({ first_message: 'first chat' });
    const list = await callGet();
    expect(list.status).toBe(200);
    const payload = (await list.json()) as { threads: Array<{ title: string }> };
    expect(payload.threads).toHaveLength(1);
    expect(payload.threads[0]!.title).toBe('first chat');
  });
});
