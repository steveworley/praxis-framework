import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as detailGet } from './[slug].ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-verbs-api-'));
  await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callDetail(slug: string): Promise<Response> {
  return Promise.resolve(
    detailGet({ params: { slug } } as unknown as Parameters<typeof detailGet>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('GET /api/verbs/[slug]', () => {
  it('returns the detail with rendered body_html', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'escalate.md'),
      [
        '---',
        'verb: reflect',
        'when_to_run: end of run',
        'inputs: []',
        'outputs: []',
        '---',
        '',
        '# Escalate Verb',
        '',
        'Raise your hand when stuck.',
      ].join('\n'),
      'utf-8',
    );
    const res = await callDetail('escalate');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      slug: string;
      file: string;
      tag: string;
      frontmatter: { verb?: string };
      body: string;
      body_html: string;
    };
    expect(payload.slug).toBe('escalate');
    expect(payload.file).toBe(path.join('verbs', 'escalate.md'));
    expect(payload.tag).toBe('reflect');
    expect(payload.frontmatter.verb).toBe('reflect');
    expect(payload.body).toContain('# Escalate Verb');
    expect(payload.body_html).toContain('<h1>Escalate Verb</h1>');
  });

  it('returns 404 for a missing verb', async () => {
    const res = await callDetail('does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid slug', async () => {
    const res = await callDetail('Bad-Slug');
    expect(res.status).toBe(400);
  });
});
