import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listGet } from './index.ts';
import { GET as detailGet } from './[slug].ts';
import { POST as acceptPost } from './[slug]/accept.ts';
import { POST as declinePost } from './[slug]/decline.ts';
import { POST as editPost } from './[slug]/edit.ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-triage-verb-api-'));
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedVerb(slug: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'verbs', 'proposed', `${slug}.md`), body, 'utf-8');
}

function callList(): Promise<Response> {
  return Promise.resolve(listGet({} as Parameters<typeof listGet>[0]) as Response | Promise<Response>);
}

function callDetail(slug: string): Promise<Response> {
  return Promise.resolve(
    detailGet({ params: { slug } } as unknown as Parameters<typeof detailGet>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callAccept(slug: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/verbs/proposed/${slug}/accept`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return Promise.resolve(
    acceptPost({ params: { slug }, request } as unknown as Parameters<typeof acceptPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callDecline(slug: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/verbs/proposed/${slug}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    declinePost({ params: { slug }, request } as unknown as Parameters<typeof declinePost>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callEdit(slug: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/triage/verbs/proposed/${slug}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    editPost({ params: { slug }, request } as unknown as Parameters<typeof editPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('GET /api/triage/verbs/proposed', () => {
  it('returns an empty list when none exist', async () => {
    const res = await callList();
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entries: unknown[]; count: number };
    expect(payload.entries).toEqual([]);
    expect(payload.count).toBe(0);
  });

  it('lists proposed drafts', async () => {
    await seedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\nbody`,
    );
    const res = await callList();
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entries: Array<{ slug: string }> };
    expect(payload.entries.map((e) => e.slug)).toEqual(['tidy-up']);
  });
});

describe('GET /api/triage/verbs/proposed/[slug]', () => {
  it('returns the detail', async () => {
    await seedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\ndraft body`,
    );
    const res = await callDetail('tidy-up');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { body: string };
    expect(payload.body).toContain('draft body');
  });

  it('returns 404 when missing', async () => {
    const res = await callDetail('not-here');
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid slug', async () => {
    const res = await callDetail('Bad-Slug');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/verbs/proposed/[slug]/accept', () => {
  beforeEach(async () => {
    await seedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\ndraft body`,
    );
  });

  it('moves the verb live', async () => {
    const res = await callAccept('tidy-up');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; movedTo: string };
    expect(payload.ok).toBe(true);
    expect(payload.movedTo).toBe(path.join('verbs', 'tidy-up.md'));
    const liveText = await fs.readFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'utf-8');
    expect(liveText).toContain('status: accepted');
  });

  it('accepts a body_override', async () => {
    const res = await callAccept('tidy-up', { body_override: 'refined operator body' });
    expect(res.status).toBe(200);
    const liveText = await fs.readFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'utf-8');
    expect(liveText).toContain('refined operator body');
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await callAccept('not-here');
    expect(res.status).toBe(404);
  });

  it('returns 400 when the live verb already exists', async () => {
    await fs.writeFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'existing live', 'utf-8');
    const res = await callAccept('tidy-up');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/verbs/proposed/[slug]/decline', () => {
  beforeEach(async () => {
    await seedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\ndraft body`,
    );
  });

  it('requires a reason', async () => {
    const res = await callDecline('tidy-up', {});
    expect(res.status).toBe(422);
  });

  it('declines and keeps the file', async () => {
    const res = await callDecline('tidy-up', { reason: 'too narrow' });
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'verbs', 'proposed', 'tidy-up.md'), 'utf-8');
    expect(text).toContain('status: declined');
    expect(text).toContain('too narrow');
  });
});

describe('POST /api/triage/verbs/proposed/[slug]/edit', () => {
  beforeEach(async () => {
    await seedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\nraw draft`,
    );
  });

  it('requires a body', async () => {
    const res = await callEdit('tidy-up', {});
    expect(res.status).toBe(422);
  });

  it('replaces the body in place', async () => {
    const res = await callEdit('tidy-up', { body: 'operator-refined body' });
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(tempDir, 'verbs', 'proposed', 'tidy-up.md'), 'utf-8');
    expect(text).toContain('operator-refined body');
    expect(text).not.toContain('raw draft');
    expect(text).toContain('status: proposed');
  });

  it('returns 404 for unknown slug', async () => {
    const res = await callEdit('not-here', { body: 'x' });
    expect(res.status).toBe(404);
  });
});
