import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as draftPost } from './draft.ts';
import { POST as applyPost } from './apply.ts';

// Mock the Anthropic SDK so the draft route can return deterministic content
// without hitting the network.
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
    constructor() {
      this.messages = { create: createSpy };
    }
    static APIError = APIError;
  }
  return { default: Anthropic, APIError };
});

let tempDir: string;
let prevRoleHome: string | undefined;
let prevApiKey: string | undefined;

beforeEach(async () => {
  createSpy.mockReset();
  prevRoleHome = process.env['PRAXIS_ROLE_HOME'];
  prevApiKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-coauthor-api-'));
  process.env['PRAXIS_ROLE_HOME'] = tempDir;
  await fs.mkdir(path.join(tempDir, 'escalations'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });

  // Init the repo + plant seed files used across tests.
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.name', 'Test Operator', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await fs.writeFile(path.join(tempDir, '.gitkeep'), '', 'utf-8');
  await fs.writeFile(
    path.join(tempDir, 'persona.md'),
    '# Persona — Sam\n\nOriginal voice.\n',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'escalations', '2026-05-08-tone.md'),
    `---\nkind: improvement\nurgency: normal\ncreated: 2026-05-08\nstatus: accepted\n---\n\n# Voice too formal\n\nbody`,
    'utf-8',
  );
  await git.add(['.gitkeep', 'persona.md', 'escalations/2026-05-08-tone.md']);
  await git.raw([
    '-c',
    'user.name=Test Operator',
    '-c',
    'user.email=op@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--author=Test Operator <op@example.test>',
    '--no-gpg-sign',
    '-m',
    'seed',
  ]);
});

afterEach(async () => {
  if (prevRoleHome === undefined) delete process.env['PRAXIS_ROLE_HOME'];
  else process.env['PRAXIS_ROLE_HOME'] = prevRoleHome;
  if (prevApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevApiKey;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function callDraft(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/triage/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    draftPost({ request } as unknown as Parameters<typeof draftPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

function callApply(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/triage/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    applyPost({ request } as unknown as Parameters<typeof applyPost>[0]) as
      | Response
      | Promise<Response>,
  );
}

describe('POST /api/triage/draft', () => {
  it('drafts a persona change and returns the diff', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: '# Persona — Sam\n\nRefreshed voice.\n' }],
      stop_reason: 'end_turn',
    });
    const res = await callDraft({
      escalation_id: '2026-05-08-tone',
      target: { kind: 'persona' },
      directive: 'Refresh the voice.',
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { target_path: string; diff_unified: string };
    expect(payload.target_path).toBe('persona.md');
    expect(payload.diff_unified).toContain('Refreshed voice');
  });

  it('rejects an unknown escalation with 404', async () => {
    const res = await callDraft({
      escalation_id: 'missing',
      target: { kind: 'persona' },
      directive: 'noop',
    });
    expect(res.status).toBe(404);
  });

  it('rejects path-traversy lib filename with 422 (validation)', async () => {
    const res = await callDraft({
      escalation_id: '2026-05-08-tone',
      target: { kind: 'lib', filename: '../etc/passwd' },
      directive: 'pwn',
    });
    // The Zod schema accepts the string (it just enforces length), but the
    // path resolver refuses; we should get 400 from the typed error path.
    expect(res.status).toBe(400);
  });

  it('rejects an empty directive with 422', async () => {
    const res = await callDraft({
      escalation_id: '2026-05-08-tone',
      target: { kind: 'persona' },
      directive: '   ',
    });
    expect(res.status).toBe(422);
  });

  it('rejects non-JSON body with 400', async () => {
    const res = await callDraft('not json');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/triage/apply', () => {
  it('writes the file and commits as the operator', async () => {
    const proposed = '# Persona — Sam\n\nRefreshed voice. Concise for engineers.\n';
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      target_path: 'persona.md',
      proposed_content: proposed,
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      commit_sha: string;
      commit_short_sha: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.commit_short_sha).toMatch(/^[0-9a-f]{7}$/);
    const onDisk = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');
    expect(onDisk).toBe(proposed);
  });

  it('refuses a target_path off the allowlist with 400', async () => {
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      target_path: 'memory/notes/foo.md',
      proposed_content: 'whatever',
    });
    expect(res.status).toBe(400);
  });

  it('refuses path traversal with 400', async () => {
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      target_path: '../etc/passwd',
      proposed_content: 'pwn',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the escalation does not exist', async () => {
    const res = await callApply({
      escalation_id: 'missing',
      target_path: 'persona.md',
      proposed_content: '# Persona — Sam\n\nnew\n',
    });
    expect(res.status).toBe(404);
  });
});
