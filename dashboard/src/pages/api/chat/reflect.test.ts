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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-reflect-'));
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
  const personaText = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- direct\n\n## Capabilities\n\n- runs reads\n\n## Hard inhibitions\n\n- gates approvals\n`;
  await fs.writeFile(path.join(tempDir, 'persona.md'), personaText, 'utf-8');
}

function callPost(body: unknown): Promise<Response> {
  return import('./reflect.ts').then(({ POST }) => {
    const request = new Request('http://localhost/api/chat/reflect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return Promise.resolve(
      POST({ request } as unknown as Parameters<typeof POST>[0]) as Response | Promise<Response>,
    );
  });
}

describe('POST /api/chat/reflect', () => {
  it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const res = await callPost({ thread_id: 'x' });
    expect(res.status).toBe(503);
  });

  it('returns 422 on invalid body shape', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const res = await callPost({});
    expect(res.status).toBe(422);
  });

  it('returns 404 for missing thread', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const res = await callPost({ thread_id: '2026-05-12-deadbeef' });
    expect(res.status).toBe(404);
  });

  it('refuses an empty thread (no turns yet)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { createThread } = await import('@/lib/chat/conversation.ts');
    const { thread_id } = await createThread(tempDir, 'fresh');
    const res = await callPost({ thread_id });
    expect(res.status).toBe(400);
  });

  it('runs the reflection loop and persists tool calls', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { appendTurn, createThread, loadThread } = await import(
      '@/lib/chat/conversation.ts'
    );
    const { thread_id } = await createThread(tempDir, 'opener');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'opener' });
    await appendTurn(tempDir, thread_id, {
      role: 'assistant',
      content: 'A small reply.',
    });

    createSpy
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_r',
            name: 'write_memory',
            input: {
              category: 'notes',
              title: 'voice shift to softer tone',
              body: 'Felt the room shift when I softened my opener.',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Captured that voice shift.' }],
      });

    const res = await callPost({ thread_id });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      kind: string;
      toolCalls: Array<{ name: string; result: { ok: boolean } }>;
      content: string;
    };
    expect(payload.kind).toBe('reflection');
    expect(payload.content).toContain('Captured that voice shift.');
    expect(payload.toolCalls).toHaveLength(1);
    expect(payload.toolCalls[0]!.result.ok).toBe(true);

    // Memory file was created.
    const mem = await fs.readFile(
      path.join(tempDir, 'memory/notes/voice-shift-to-softer-tone.md'),
      'utf-8',
    );
    expect(mem).toMatch(/# voice shift to softer tone/);

    // Thread file has three turns now: opener, reply, reflection.
    const loaded = await loadThread(tempDir, thread_id);
    expect(loaded.turns).toHaveLength(3);
    const reflection = loaded.turns[2]!;
    expect(reflection.role).toBe('assistant');
    expect(reflection.content).toMatch(/\*\*Reflection\.\*\*/);
    expect(reflection.toolCalls).toHaveLength(1);
  });

  it('falls back to a placeholder body when the model returns no text', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    await seedRole();
    const { appendTurn, createThread } = await import('@/lib/chat/conversation.ts');
    const { thread_id } = await createThread(tempDir, 'opener');
    await appendTurn(tempDir, thread_id, { role: 'user', content: 'opener' });

    createSpy.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [],
    });

    const res = await callPost({ thread_id });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { content: string };
    expect(payload.content).toMatch(/Reflection/);
  });
});
