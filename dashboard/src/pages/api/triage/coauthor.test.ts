import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as proposePost } from './propose.ts';
import { POST as applyPost } from './apply.ts';

// Mock the Anthropic SDK so the propose route can return deterministic content
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

function callPropose(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/triage/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return Promise.resolve(
    proposePost({ request } as unknown as Parameters<typeof proposePost>[0]) as
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

function toolUseResponse(
  calls: Array<{ path: string; new_content: string; rationale: string }>,
): unknown {
  return {
    stop_reason: 'tool_use',
    content: calls.map((c, i) => ({
      type: 'tool_use',
      id: `call_${i}`,
      name: 'propose_file_change',
      input: { path: c.path, new_content: c.new_content, rationale: c.rationale },
    })),
  };
}

function endTurnResponse(summary: string): unknown {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: summary }],
  };
}

describe('POST /api/triage/propose', () => {
  it('returns 1-N proposals with diffs', async () => {
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            path: 'persona.md',
            new_content: '# Persona — Sam\n\nRefreshed voice.\n',
            rationale: 'Refresh voice section.',
          },
        ]),
      )
      .mockResolvedValueOnce(endTurnResponse('Refreshed the persona voice.'));

    const res = await callPropose({ escalation_id: '2026-05-08-tone' });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      escalation_id: string;
      proposals: Array<{ path: string; diff_unified: string; kind: string; rationale: string }>;
      summary: string;
    };
    expect(payload.escalation_id).toBe('2026-05-08-tone');
    expect(payload.proposals).toHaveLength(1);
    expect(payload.proposals[0]!.path).toBe('persona.md');
    expect(payload.proposals[0]!.kind).toBe('persona');
    expect(payload.proposals[0]!.diff_unified).toContain('Refreshed voice');
    expect(payload.summary).toContain('Refreshed');
  });

  it('rejects an unknown escalation with 404', async () => {
    const res = await callPropose({ escalation_id: 'missing' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the model never accepts a proposal', async () => {
    createSpy.mockResolvedValueOnce(endTurnResponse('I am stuck.'));
    const res = await callPropose({ escalation_id: '2026-05-08-tone' });
    expect(res.status).toBe(400);
  });

  it('rejects non-JSON body with 400', async () => {
    const res = await callPropose('not json');
    expect(res.status).toBe(400);
  });

  it('rejects an empty body with 422', async () => {
    const res = await callPropose({});
    expect(res.status).toBe(422);
  });
});

describe('POST /api/triage/apply', () => {
  it('writes the file and commits as the operator', async () => {
    const proposed = '# Persona — Sam\n\nRefreshed voice. Concise for engineers.\n';
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      proposals: [{ path: 'persona.md', proposed_content: proposed }],
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      ok: boolean;
      commit_sha: string;
      commit_short_sha: string;
      files_changed: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.commit_short_sha).toMatch(/^[0-9a-f]{7}$/);
    expect(payload.files_changed).toEqual(['persona.md']);
    const onDisk = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');
    expect(onDisk).toBe(proposed);
  });

  it('refuses a target_path off the allowlist with 400', async () => {
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      proposals: [{ path: 'memory/notes/foo.md', proposed_content: 'whatever' }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses path traversal with 400', async () => {
    const res = await callApply({
      escalation_id: '2026-05-08-tone',
      proposals: [{ path: '../etc/passwd', proposed_content: 'pwn' }],
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the escalation does not exist', async () => {
    const res = await callApply({
      escalation_id: 'missing',
      proposals: [
        { path: 'persona.md', proposed_content: '# Persona — Sam\n\nnew\n' },
      ],
    });
    expect(res.status).toBe(404);
  });

  it('rejects a missing proposals array with 422', async () => {
    const res = await callApply({ escalation_id: '2026-05-08-tone' });
    expect(res.status).toBe(422);
  });
});
