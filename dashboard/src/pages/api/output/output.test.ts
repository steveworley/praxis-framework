import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listGet } from './index.ts';
import {
  GET as detailGet,
  POST as statusPost,
} from './[type]/[...slug].ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-output-api-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
  await fs.mkdir(path.join(tempDir, 'output/document'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/draft'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/record/account/acme'), { recursive: true });

  await fs.writeFile(
    path.join(tempDir, 'output/document/q1-brief.md'),
    [
      '---',
      'type: document',
      'slug: q1-brief',
      'status: ready',
      'title: Q1 brief',
      'created: 2026-05-01T10:00:00+10:00',
      'updated: 2026-05-02T11:00:00+10:00',
      '---',
      '',
      'The body.',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/draft/cold-mary.md'),
    [
      '---',
      'type: draft',
      'slug: cold-mary',
      'status: draft',
      'recipient: mary@acme.com',
      'channel: email',
      'subject: Quick question',
      'created: 2026-05-13T08:00:00+10:00',
      'updated: 2026-05-13T08:00:00+10:00',
      '---',
      '',
      'Hi Mary.',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/record/account/acme/2026-q1.md'),
    [
      '---',
      'type: record',
      'slug: 2026-q1',
      'status: done',
      'entity_type: account',
      'entity_id: acme',
      'observed_at: 2026-04-28',
      'created: 2026-04-28T15:00:00+10:00',
      'updated: 2026-04-28T15:00:00+10:00',
      '---',
      '',
      'Read.',
    ].join('\n'),
    'utf-8',
  );

  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callList(qs = ''): Promise<Response> {
  const url = new URL(`http://localhost/api/output${qs}`);
  return Promise.resolve(
    listGet({ url } as unknown as Parameters<typeof listGet>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callDetail(type: string, slug: string): Promise<Response> {
  return Promise.resolve(
    detailGet({ params: { type, slug } } as unknown as Parameters<typeof detailGet>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callStatus(type: string, slug: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/output/${type}/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    statusPost({ params: { type, slug }, request } as unknown as Parameters<typeof statusPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('GET /api/output', () => {
  it('lists all seeded outputs', async () => {
    const res = await callList();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ slug: string }>; count: number };
    expect(body.count).toBe(3);
  });

  it('filters by type', async () => {
    const res = await callList('?type=draft');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ slug: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.slug).toBe('cold-mary');
  });

  it('filters by status', async () => {
    const res = await callList('?status=ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ slug: string }> };
    expect(body.entries.map((e) => e.slug)).toEqual(['q1-brief']);
  });

  it('rejects unknown status with 422', async () => {
    const res = await callList('?status=nope');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/output/[type]/[...slug]', () => {
  it('loads a single-segment output', async () => {
    const res = await callDetail('document', 'q1-brief');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { slug: string }; body: string; body_html: string };
    expect(body.meta.slug).toBe('q1-brief');
    expect(body.body.trim()).toBe('The body.');
    expect(body.body_html).toContain('<p>');
  });

  it('loads a record from multi-segment slug', async () => {
    const res = await callDetail('record', 'account/acme/2026-q1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { slug: string; extras: Record<string, string> } };
    expect(body.meta.slug).toBe('2026-q1');
    expect(body.meta.extras['entity_id']).toBe('acme');
  });

  it('returns 404 for missing files', async () => {
    const res = await callDetail('document', 'nope');
    expect(res.status).toBe(404);
  });

  it('returns 400 for path traversal', async () => {
    const res = await callDetail('document', '../persona');
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown type', async () => {
    const res = await callDetail('meme', 'x');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/output/[type]/[...slug]', () => {
  it('updates status and returns the updated meta', async () => {
    const res = await callStatus('draft', 'cold-mary', { status: 'sent' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      meta: { status: string };
      previous_status: string;
    };
    expect(body.ok).toBe(true);
    expect(body.meta.status).toBe('sent');
    expect(body.previous_status).toBe('draft');

    // On-disk verification.
    const written = await fs.readFile(
      path.join(tempDir, 'output/draft/cold-mary.md'),
      'utf-8',
    );
    expect(written).toMatch(/status: sent/);
  });

  it('rejects invalid status with 422', async () => {
    const res = await callStatus('draft', 'cold-mary', { status: 'rejected' });
    expect(res.status).toBe(422);
  });

  it('returns 404 for missing target', async () => {
    const res = await callStatus('document', 'nope', { status: 'sent' });
    expect(res.status).toBe(404);
  });
});
