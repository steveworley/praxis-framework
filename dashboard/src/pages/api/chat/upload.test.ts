import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST } from './upload.ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-upload-'));
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function buildRequest(form: FormData): Request {
  return new Request('http://localhost/api/chat/upload', {
    method: 'POST',
    body: form,
  });
}

function callPost(form: FormData): Promise<Response> {
  return Promise.resolve(
    POST({ request: buildRequest(form) } as unknown as Parameters<typeof POST>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('POST /api/chat/upload', () => {
  it('writes the upload under lib/uploads/<thread_id>/', async () => {
    const form = new FormData();
    form.set('thread_id', '2026-05-12-abcdef');
    form.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const res = await callPost(form);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      path: string;
      filename: string;
      size: number;
      mime_type: string;
    };
    expect(payload.path).toBe('lib/uploads/2026-05-12-abcdef/note.txt');
    expect(payload.size).toBe(5);
    expect(payload.mime_type).toBe('text/plain');

    const written = await fs.readFile(
      path.join(tempDir, 'lib', 'uploads', '2026-05-12-abcdef', 'note.txt'),
      'utf-8',
    );
    expect(written).toBe('hello');
  });

  it('rejects thread_id with path traversal', async () => {
    const form = new FormData();
    form.set('thread_id', '../escape');
    form.set('file', new File(['hi'], 'a.txt', { type: 'text/plain' }));
    const res = await callPost(form);
    expect(res.status).toBe(400);
  });

  it('refuses filenames that traverse parent directories', async () => {
    const form = new FormData();
    form.set('thread_id', '2026-05-12-abcdef');
    form.set('file', new File(['hi'], '../escape.txt', { type: 'text/plain' }));
    const res = await callPost(form);
    // basename strips the leading ../ so this should still land safely under
    // the uploads directory. The point is no escape happens.
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string };
    expect(payload.path).toBe('lib/uploads/2026-05-12-abcdef/escape.txt');
  });

  it('rejects an upload that exceeds the 5 MB cap', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const form = new FormData();
    form.set('thread_id', '2026-05-12-abcdef');
    form.set('file', new File([big], 'big.bin', { type: 'application/octet-stream' }));
    const res = await callPost(form);
    expect(res.status).toBe(413);
  });

  it('returns 400 when the body is not multipart', async () => {
    const req = new Request('http://localhost/api/chat/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: 'x' }),
    });
    const res = await Promise.resolve(
      POST({ request: req } as unknown as Parameters<typeof POST>[0]) as Response | Promise<Response>,
    );
    expect(res.status).toBe(400);
  });
});
