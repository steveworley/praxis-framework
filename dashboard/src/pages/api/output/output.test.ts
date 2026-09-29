import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadReadyCommit } from '@/lib/output/approval';

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

describe('POST /api/output/[type]/[...slug] with extra fields', () => {
  it('keeps role-defined extra fields when the operator changes status', async () => {
    const draftPath = path.join(tempDir, 'output/draft/reply-reporter.md');
    await fs.writeFile(
      draftPath,
      [
        '---',
        'type: draft',
        'slug: reply-reporter',
        'status: review',
        'recipient: reporter@example.com',
        'channel: email',
        'subject: Re: report',
        "gmail_thread_id: 'thread:18f2a9c0'",
        'reporter_ref: VDP-2026-014',
        'created: 2026-09-29T13:00:00+10:00',
        'updated: 2026-09-29T13:00:00+10:00',
        '---',
        '',
        'Thanks for the report.',
      ].join('\n'),
      'utf-8',
    );

    const res = await callStatus('draft', 'reply-reporter', { status: 'ready' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { status: string; extraFields: Record<string, string> };
    };
    expect(body.meta.status).toBe('ready');
    expect(body.meta.extraFields).toEqual({
      gmail_thread_id: 'thread:18f2a9c0',
      reporter_ref: 'VDP-2026-014',
    });

    const lines = (await fs.readFile(draftPath, 'utf-8')).split('\n');
    expect(lines).toContain("gmail_thread_id: 'thread:18f2a9c0'");
    expect(lines).toContain('reporter_ref: VDP-2026-014');
    expect(lines).toContain('status: ready');
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

describe('POST /api/output/[type]/[...slug] — operator re-approval of a role-set ready', () => {
  const REL = 'output/draft/cold-mary.md';
  const OPERATOR = { name: 'Steve Operator', email: 'steve@example.test' };

  async function commitAll(author: string, subject: string): Promise<void> {
    const git = simpleGit(tempDir);
    await git.raw(['add', '-A', '.']);
    await git.raw(['-c', 'commit.gpgsign=false', 'commit', `--author=${author}`, '-m', subject]);
  }

  async function setStatusOnDisk(status: string): Promise<void> {
    const abs = path.join(tempDir, REL);
    const text = await fs.readFile(abs, 'utf-8');
    await fs.writeFile(abs, text.replace(/^status: .*$/m, `status: ${status}`), 'utf-8');
  }

  beforeEach(async () => {
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', OPERATOR.name, false, 'local');
    await git.addConfig('user.email', OPERATOR.email, false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    await commitAll('Praxis Role <role@praxis.local>', 'role(output): write draft cold-mary');
    await setStatusOnDisk('ready');
    await commitAll('Praxis Role <role@praxis.local>', 'role(output): status cold-mary: draft → ready');
  });

  it('starts from a ready the role set itself', async () => {
    expect((await loadReadyCommit(tempDir, REL))?.byOperator).toBe(false);
  });

  it('records a new operator commit that sets ready, visible to git log -G', async () => {
    const res = await callStatus('draft', 'cold-mary', { status: 'ready' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { status: string };
      previous_status: string;
      commit_sha?: string;
    };
    expect(body.meta.status).toBe('ready');
    expect(body.previous_status).toBe('ready');

    const ready = await loadReadyCommit(tempDir, REL);
    expect(ready?.byOperator).toBe(true);
    expect(ready?.authorEmail).toBe(OPERATOR.email);

    const head = (await simpleGit(tempDir).revparse(['HEAD'])).trim();
    expect(body.commit_sha).toBe(head);
    const subjects = (
      await simpleGit(tempDir).raw(['log', '-2', '--pretty=format:%ae %s'])
    ).split('\n');
    expect(subjects).toEqual([
      `${OPERATOR.email} operator(output): status cold-mary: review → ready`,
      `${OPERATOR.email} operator(output): status cold-mary: ready → review`,
    ]);
  });

  it('leaves the file ready on disk', async () => {
    await callStatus('draft', 'cold-mary', { status: 'ready' });
    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toMatch(/^status: ready$/m);
  });

  it('does not add the review hop for other statuses', async () => {
    await setStatusOnDisk('review');
    await commitAll('Praxis Role <role@praxis.local>', 'role(output): status cold-mary: ready → review');
    await callStatus('draft', 'cold-mary', { status: 'ready' });
    const subjects = (
      await simpleGit(tempDir).raw(['log', '-1', '--pretty=format:%s'])
    ).trim();
    expect(subjects).toBe('operator(output): status cold-mary: review → ready');
    const count = (await simpleGit(tempDir).raw(['rev-list', '--count', 'HEAD'])).trim();
    expect(count).toBe('4');
  });
});
