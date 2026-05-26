import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';

import { GET, PUT } from './business-context.ts';

let roleHome: string;

async function makeRole(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bc-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', 'Op', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  return dir;
}

afterEach(() => {
  delete process.env['PRAXIS_ROLE_HOME'];
});

function req(body: unknown): Request {
  return new Request('http://x/api/role/business-context', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('business-context endpoint', () => {
  it('GET returns initialised:false for a legacy role', async () => {
    roleHome = await makeRole();
    process.env['PRAXIS_ROLE_HOME'] = roleHome;
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ initialised: false });
  });

  it('PUT writes + commits, then GET returns the record', async () => {
    roleHome = await makeRole();
    process.env['PRAXIS_ROLE_HOME'] = roleHome;
    const putRes = await PUT({
      request: req({
        version: 1,
        business_context: [{ key: 'what_we_do', label: 'What we do', value: 'Coffee.' }],
      }),
    } as never);
    expect(putRes.status).toBe(200);
    const onDisk = await readFile(path.join(roleHome, 'lib', 'business-context.yaml'), 'utf-8');
    expect(onDisk).toContain('Coffee.');
    const log = await simpleGit(roleHome).log();
    expect(log.latest?.message).toMatch(/business context/i);
    const getRes = await GET({} as never);
    expect(await getRes.json()).toMatchObject({ initialised: true });
  });

  it('PUT rejects an invalid payload with 422', async () => {
    roleHome = await makeRole();
    process.env['PRAXIS_ROLE_HOME'] = roleHome;
    const res = await PUT({ request: req({ business_context: 'nope' }) } as never);
    expect(res.status).toBe(422);
  });
});
