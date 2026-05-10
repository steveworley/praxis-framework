import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from './load-draft.ts';

let tempDir: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-loaddraft-'));
  prevEnv = process.env['PRAXIS_ROLE_HOME'];
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevEnv;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callGet(): Promise<Response> {
  // The astro APIRoute signature passes a context object; we only hit fields the
  // implementation reads, so an empty object is enough for this test.
  return Promise.resolve(GET({} as Parameters<typeof GET>[0]) as Response | Promise<Response>);
}

describe('GET /api/setup/load-draft', () => {
  it("returns kind: 'pending' when the draft file is absent", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.kind).toBe('pending');
    expect(payload.expected_path).toBe('.praxis/persona-draft.md');
  });

  it("returns kind: 'ready' with the parsed persona when the draft is well-formed", async () => {
    const draftDir = path.join(tempDir, '.praxis');
    await fs.mkdir(draftDir, { recursive: true });
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can run weekly reads\n\n## Hard inhibitions\n\n- I never send without approval\n\n## Initial verbs\n\n- **account-read** -- weekly customer read\n`;
    await fs.writeFile(path.join(draftDir, 'persona-draft.md'), text, 'utf-8');

    const res = await callGet();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.kind).toBe('ready');
    expect(payload.persona.identity.full_name).toBe('Iris Chen');
    expect(payload.persona.voice).toEqual([
      { trait: 'direct', qualifiers: ['single-sentence opens'] },
    ]);
    expect(payload.persona.capabilities).toEqual(['I can run weekly reads']);
    expect(payload.persona.inhibitions).toEqual(['I never send without approval']);
    expect(payload.persona.initial_verbs).toEqual([
      { slug: 'account-read', description: ['weekly customer read'] },
    ]);
  });

  it("returns kind: 'error' when the draft is empty of recognisable sections", async () => {
    const draftDir = path.join(tempDir, '.praxis');
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(path.join(draftDir, 'persona-draft.md'), '# Persona — Empty\n', 'utf-8');

    const res = await callGet();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.kind).toBe('error');
    expect(payload.message).toMatch(/no voice/i);
  });
});
