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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-msg-'));
  prevHome = process.env['PRAXIS_ROLE_HOME'];
  prevKey = process.env['ANTHROPIC_API_KEY'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
  createSpy.mockReset();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevHome;
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedRole(): Promise<void> {
  const personaText = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I run weekly reads\n\n## Hard inhibitions\n\n- I never send without approval\n`;
  await fs.writeFile(path.join(tempDir, 'persona.md'), personaText, 'utf-8');
}

function callPost(body: unknown): Promise<Response> {
  return import('./message.ts').then(({ POST }) => {
    const request = new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return Promise.resolve(
      POST({ request } as unknown as Parameters<typeof POST>[0]) as Response | Promise<Response>,
    );
  });
}

describe('POST /api/chat/message', () => {
  it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const res = await callPost({ thread_id: 'x', content: 'hi' });
    expect(res.status).toBe(503);
  });

  it('returns 422 on invalid body shape', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const res = await callPost({ thread_id: 'x' });
    expect(res.status).toBe(422);
  });

  it('returns 400 when thread_id contains traversal characters', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const res = await callPost({ thread_id: '../escape', content: 'hi' });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the thread file does not exist', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const res = await callPost({ thread_id: '2026-05-12-deadbeef', content: 'hi' });
    expect(res.status).toBe(404);
  });

  it('runs the chat turn end-to-end and persists user + assistant turns', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { createThread, loadThread } = await import('@/lib/chat/conversation.ts');
    const { thread_id } = await createThread(tempDir, 'first question');

    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'My answer.' }],
    });

    const res = await callPost({ thread_id, content: 'second question' });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { role: string; content: string };
    expect(payload.role).toBe('assistant');
    expect(payload.content).toBe('My answer.');

    const detail = await loadThread(tempDir, thread_id);
    expect(detail.turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant']);
    expect(detail.turns[1]!.content).toBe('second question');
    expect(detail.turns[2]!.content).toBe('My answer.');

    // The system prompt should have been passed.
    const callArgs = createSpy.mock.calls[0]![0] as { system: string; messages: unknown[] };
    expect(callArgs.system).toContain('You are Iris Chen.');
    expect(callArgs.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'user', content: 'second question' },
    ]);
  });
});
