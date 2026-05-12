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
    const { appendTurn, createThread, loadThread } = await import(
      '@/lib/chat/conversation.ts'
    );
    const { thread_id } = await createThread(tempDir, 'first question');
    // createThread writes frontmatter only; the prior turn is appended
    // explicitly to mirror what /api/chat/message does on the first send.
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'first question' });

    createSpy.mockResolvedValueOnce({
      stop_reason: 'end_turn',
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

  it('runs a tool-use loop and persists tool calls onto the assistant turn', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { appendTurn, createThread, loadThread } = await import(
      '@/lib/chat/conversation.ts'
    );
    const { thread_id } = await createThread(tempDir, 'remember Mary');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'remember Mary' });

    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'write_memory',
            input: {
              category: 'people',
              title: 'Mary Chen at Acme',
              body: 'She prefers async updates.',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Noted Mary in my memory.' }],
      });

    const res = await callPost({ thread_id, content: 'next' });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      content: string;
      toolCalls: Array<{ name: string; result: { ok: boolean } }>;
    };
    expect(payload.content).toBe('Noted Mary in my memory.');
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.toolCalls[0]!.name).toBe('write_memory');
    expect(payload.toolCalls[0]!.result.ok).toBe(true);

    // The memory file was actually written.
    const memText = await fs.readFile(
      path.join(tempDir, 'memory/people/mary-chen-at-acme.md'),
      'utf-8',
    );
    expect(memText).toMatch(/# Mary Chen at Acme/);

    // The thread file persisted the tool-call fence on reload.
    const detail = await loadThread(tempDir, thread_id);
    const assistant = detail.turns[2]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]?.name).toBe('write_memory');
  });

  it('records a tool-call error result and lets the model recover', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { appendTurn, createThread } = await import('@/lib/chat/conversation.ts');
    const { thread_id } = await createThread(tempDir, 'try');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'try' });

    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_x',
            name: 'write_memory',
            // category is missing → input validation refusal.
            input: { title: 'x', body: 'y' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'I could not write that.' }],
      });

    const res = await callPost({ thread_id, content: 'next' });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      toolCalls: Array<{ result: { ok: boolean; error?: string } }>;
    };
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.toolCalls[0]!.result.ok).toBe(false);
    expect(payload.toolCalls[0]!.result.error).toMatch(/invalid/);
  });
});
