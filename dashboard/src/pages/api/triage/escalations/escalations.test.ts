import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listGet } from './index.ts';
import { GET as detailGet } from './[id].ts';
import { POST as acceptPost } from './[id]/accept.ts';
import { POST as declinePost } from './[id]/decline.ts';
import { POST as commentPost } from './[id]/comment.ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-triage-api-'));
  await fs.mkdir(path.join(tempDir, 'escalations'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedEsc(id: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'escalations', `${id}.md`), body, 'utf-8');
}

function callList(qs = ''): Promise<Response> {
  const url = new URL(`http://localhost/api/triage/escalations${qs}`);
  return Promise.resolve(listGet({ url } as unknown as Parameters<typeof listGet>[0]) as Response | Promise<Response>);
}

function callDetail(id: string): Promise<Response> {
  return Promise.resolve(
    detailGet({ params: { id } } as unknown as Parameters<typeof detailGet>[0]) as Response | Promise<Response>,
  );
}

function callAccept(id: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/escalations/${id}/accept`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return Promise.resolve(
    acceptPost({ params: { id }, request } as unknown as Parameters<typeof acceptPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callDecline(id: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/escalations/${id}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    declinePost({ params: { id }, request } as unknown as Parameters<typeof declinePost>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callComment(id: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/escalations/${id}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    commentPost({ params: { id }, request } as unknown as Parameters<typeof commentPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('GET /api/triage/escalations', () => {
  it('returns an empty list when no escalations exist', async () => {
    const res = await callList();
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entries: unknown[]; status: string };
    expect(payload.entries).toEqual([]);
    expect(payload.status).toBe('all');
  });

  it('filters by status', async () => {
    await seedEsc(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n# A`,
    );
    await seedEsc(
      '2026-05-02-b',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-02\nstatus: accepted\n---\n# B`,
    );
    const res = await callList('?status=open');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entries: Array<{ id: string }> };
    expect(payload.entries.map((e) => e.id)).toEqual(['2026-05-01-a']);
  });

  it('rejects an invalid status with 422', async () => {
    const res = await callList('?status=wat');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/triage/escalations/[id]', () => {
  it('returns the full escalation detail', async () => {
    await seedEsc(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n\n# Need help\n\nasking for X`,
    );
    const res = await callDetail('2026-05-01-a');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { title: string; body: string };
    expect(payload.title).toBe('Need help');
    expect(payload.body).toContain('asking for X');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await callDetail('2026-05-01-missing');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a path-traversal id', async () => {
    const res = await callDetail('../foo');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/escalations/[id]/accept', () => {
  beforeEach(async () => {
    await seedEsc(
      '2026-05-01-a',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-01\nstatus: open\n---\n# A\n\nbody`,
    );
  });

  it('flips status to accepted without a body', async () => {
    const res = await callAccept('2026-05-01-a');
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('status: accepted');
  });

  it('accepts an operator_note in the body', async () => {
    const res = await callAccept('2026-05-01-a', { operator_note: 'will land next week' });
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('will land next week');
  });

  it('returns 404 for unknown id', async () => {
    const res = await callAccept('2026-05-01-missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/triage/escalations/[id]/decline', () => {
  beforeEach(async () => {
    await seedEsc(
      '2026-05-01-a',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-01\nstatus: open\n---\n# A`,
    );
  });

  it('rejects missing reason with 422', async () => {
    const res = await callDecline('2026-05-01-a', {});
    expect(res.status).toBe(422);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await callDecline('2026-05-01-a', 'not-json');
    expect(res.status).toBe(400);
  });

  it('declines with a reason', async () => {
    const res = await callDecline('2026-05-01-a', { reason: 'duplicate of #42' });
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('status: declined');
    expect(text).toContain('duplicate of #42');
  });
});

describe('POST /api/triage/escalations/[id]/comment', () => {
  beforeEach(async () => {
    await seedEsc(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n# A`,
    );
  });

  it('appends a note and keeps status', async () => {
    const res = await callComment('2026-05-01-a', { note: 'looking into this' });
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('looking into this');
    expect(text).toContain('status: open');
  });

  it('rejects empty note', async () => {
    const res = await callComment('2026-05-01-a', { note: '  ' });
    expect(res.status).toBe(422);
  });
});
