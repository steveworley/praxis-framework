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

function buildRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function callPost(body: unknown): Promise<Response> {
  return Promise.resolve(
    POST({ request: buildRequest(body) } as unknown as Parameters<typeof POST>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('POST /api/chat/upload', () => {
  it('writes a base64 upload under lib/uploads/<thread_id>/', async () => {
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'note.txt',
      mime_type: 'text/plain',
      data: Buffer.from('hello').toString('base64'),
    });
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

  it('strips a data-URL prefix before decoding', async () => {
    const base64 = Buffer.from('hello').toString('base64');
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'note.txt',
      mime_type: 'text/plain',
      data: `data:text/plain;base64,${base64}`,
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { size: number };
    expect(payload.size).toBe(5);

    const written = await fs.readFile(
      path.join(tempDir, 'lib', 'uploads', '2026-05-12-abcdef', 'note.txt'),
      'utf-8',
    );
    expect(written).toBe('hello');
  });

  it('defaults the mime type when omitted', async () => {
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'blob.bin',
      data: Buffer.from('xy').toString('base64'),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { mime_type: string };
    expect(payload.mime_type).toBe('application/octet-stream');
  });

  it('rejects thread_id with path traversal', async () => {
    const res = await callPost({
      thread_id: '../escape',
      filename: 'a.txt',
      data: Buffer.from('hi').toString('base64'),
    });
    expect(res.status).toBe(400);
  });

  it('rejects thread_id containing a slash', async () => {
    const res = await callPost({
      thread_id: 'a/b',
      filename: 'a.txt',
      data: Buffer.from('hi').toString('base64'),
    });
    expect(res.status).toBe(400);
  });

  it('refuses filenames that traverse parent directories', async () => {
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: '../escape.txt',
      data: Buffer.from('hi').toString('base64'),
    });
    // basename strips the leading ../ so this should still land safely under
    // the uploads directory. The point is no escape happens.
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: string };
    expect(payload.path).toBe('lib/uploads/2026-05-12-abcdef/escape.txt');
  });

  it('rejects an upload that exceeds the 5 MB cap', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'big.bin',
      mime_type: 'application/octet-stream',
      data: big,
    });
    expect(res.status).toBe(413);
  });

  it('returns 400 when the decoded buffer is empty', async () => {
    // A non-empty string that decodes to zero bytes (whitespace is ignored by
    // the base64 decoder).
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'empty.bin',
      data: ' ',
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 when required fields are missing', async () => {
    const res = await callPost({ thread_id: '2026-05-12-abcdef' });
    expect(res.status).toBe(422);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('Validation failed');
  });

  it('returns 422 when data is an empty string', async () => {
    const res = await callPost({
      thread_id: '2026-05-12-abcdef',
      filename: 'empty.bin',
      data: '',
    });
    expect(res.status).toBe(422);
  });

  it('returns 400 when the body is not valid JSON', async () => {
    const res = await callPost('not json');
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('Invalid JSON body');
  });
});
