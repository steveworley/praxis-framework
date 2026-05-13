import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
let prevHome: string | undefined;
let prevKey: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-summarise-route-'));
  prevHome = process.env['PRAXIS_ROLE_HOME'];
  prevKey = process.env['ANTHROPIC_API_KEY'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  createSpy.mockReset();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevHome;
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedThread(threadId: string, turnCount: number): Promise<void> {
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
  const turns: string[] = [];
  for (let i = 0; i < turnCount; i += 1) {
    const role = i % 2 === 0 ? 'User' : 'Assistant';
    turns.push(`## ${role} · 2026-05-13T10:0${i}:00Z\n\nturn ${i}`);
  }
  await fs.writeFile(
    path.join(dir, `${threadId}.md`),
    `${fm}\n\n${turns.join('\n\n')}\n`,
    'utf-8',
  );
}

function callPost(id: string): Promise<Response> {
  return import('./summarise.ts').then(({ POST }) => {
    return Promise.resolve(
      POST({ params: { id } } as unknown as Parameters<typeof POST>[0]) as
        | Response
        | Promise<Response>,
    );
  });
}

describe('POST /api/chat/threads/[id]/summarise', () => {
  it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const res = await callPost('whatever');
    expect(res.status).toBe(503);
  });

  it('returns 400 on unsafe thread id', async () => {
    const res = await callPost('../escape');
    expect(res.status).toBe(400);
  });

  it('returns 422 when the thread is too short to summarise', async () => {
    await seedThread('thread-2', 2);
    const res = await callPost('thread-2');
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/has only 2 turn/);
  });

  it('returns 404 when the thread does not exist', async () => {
    const res = await callPost('thread-missing');
    expect(res.status).toBe(404);
  });

  it('returns 200 with the refreshed thread and archived path on success', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '- A brief summary.' }],
      stop_reason: 'end_turn',
    });
    await seedThread('thread-4', 4);
    const res = await callPost('thread-4');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      thread: { thread_id: string };
      turns: Array<{ role: string; content: string }>;
      archivedPath: string;
      turnRange: { from: number; to: number };
    };
    expect(body.ok).toBe(true);
    expect(body.thread.thread_id).toBe('thread-4');
    expect(body.archivedPath).toMatch(/^memory\/conversations\/archived\/thread-4-turns-1-2-/);
    expect(body.turnRange).toEqual({ from: 1, to: 2 });
    // Summary turn + 2 newer turns preserved verbatim.
    expect(body.turns).toHaveLength(3);
    expect(body.turns[0]!.role).toBe('summary');
  });
});
