import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CoauthorValidationError,
  applyChange,
  classifyAndAssertPath,
  proposeChange,
} from './index.ts';

// Mock the Anthropic SDK at the module boundary so we can shape the propose
// loop deterministically. Mirrors dashboard/src/lib/chat/anthropic.test.ts.
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
let prevKey: string | undefined;

beforeEach(async () => {
  createSpy.mockReset();
  prevKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-coauthor-'));
  await fs.mkdir(path.join(tempDir, 'escalations'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
});

afterEach(async () => {
  if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = prevKey;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedEscalation(id: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'escalations', `${id}.md`), body, 'utf-8');
}

async function seedFile(rel: string, body: string): Promise<void> {
  const abs = path.join(tempDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

async function initRepo(): Promise<void> {
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.name', 'Test Operator', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  // Plant a baseline commit so HEAD exists.
  await fs.writeFile(path.join(tempDir, '.gitkeep'), '', 'utf-8');
  await git.add('.gitkeep');
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
    'init',
  ]);
}

/**
 * Shape an Anthropic.Message that emits one or more `tool_use` blocks with
 * `propose_file_change` inputs, then ends with an `end_turn` text block.
 *
 * The model loop in propose can take multiple round trips — first response
 * with tool_use blocks, then a final `end_turn` text response containing the
 * summary. The helpers below let tests script both stages.
 */
interface ToolCallSpec {
  path: string;
  new_content: string;
  rationale: string;
}

function toolUseResponse(calls: ToolCallSpec[]): unknown {
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

describe('classifyAndAssertPath', () => {
  it('classifies persona.md as persona', () => {
    expect(classifyAndAssertPath('persona.md')).toBe('persona');
  });

  it('classifies CLAUDE.md as claude-md', () => {
    expect(classifyAndAssertPath('CLAUDE.md')).toBe('claude-md');
  });

  it('classifies verbs/<slug>.md as verb', () => {
    expect(classifyAndAssertPath('verbs/escalate.md')).toBe('verb');
  });

  it('classifies lib/<filename> as lib', () => {
    expect(classifyAndAssertPath('lib/team.yaml')).toBe('lib');
  });

  it('refuses verbs/proposed/ paths', () => {
    expect(() => classifyAndAssertPath('verbs/proposed/foo.md')).toThrow(
      CoauthorValidationError,
    );
  });

  it('refuses constitutional lib files', () => {
    expect(() => classifyAndAssertPath('lib/customers.yaml')).toThrow(
      CoauthorValidationError,
    );
    expect(() => classifyAndAssertPath('lib/compliance.yaml')).toThrow(
      CoauthorValidationError,
    );
    expect(() => classifyAndAssertPath('lib/autonomy.yaml')).toThrow(
      CoauthorValidationError,
    );
    expect(() => classifyAndAssertPath('lib/tools.yaml')).toThrow(CoauthorValidationError);
  });

  it('refuses arbitrary paths off the allowlist', () => {
    expect(() => classifyAndAssertPath('memory/notes/foo.md')).toThrow(
      CoauthorValidationError,
    );
    expect(() => classifyAndAssertPath('output/document/foo.md')).toThrow(
      CoauthorValidationError,
    );
  });

  it('refuses lib filenames with disallowed extensions', () => {
    expect(() => classifyAndAssertPath('lib/foo.sh')).toThrow(CoauthorValidationError);
  });
});

describe('proposeChange', () => {
  beforeEach(async () => {
    await seedEscalation(
      '2026-05-08-tone',
      `---\nkind: improvement\nurgency: normal\ncreated: 2026-05-08\nstatus: accepted\n---\n\n# Voice too formal for engineering contacts\n\nI keep falling back to corporate tone when emailing engineers.`,
    );
    await seedFile(
      'persona.md',
      '# Persona — Sam\n\n## Voice\n\nWarm, concise, business-casual.\n',
    );
    await seedFile('CLAUDE.md', '# CLAUDE.md\n\nOperating manual.\n');
    await seedFile('verbs/escalate.md', '# escalate\n\nDo the thing.\n');
  });

  it('returns a single-file proposal with diff + rationale + summary', async () => {
    const newPersona =
      '# Persona — Sam\n\n## Voice\n\nWarm, concise, business-casual. With engineering contacts, lean concise — short paragraphs, no flourish.\n';
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            path: 'persona.md',
            new_content: newPersona,
            rationale: 'Add concise mode for engineering contacts.',
          },
        ]),
      )
      .mockResolvedValueOnce(
        endTurnResponse('Adjusted persona voice to add a concise mode for engineering contacts.'),
      );

    const result = await proposeChange(tempDir, { escalation_id: '2026-05-08-tone' });

    expect(result.escalation_id).toBe('2026-05-08-tone');
    expect(result.proposals).toHaveLength(1);
    const p0 = result.proposals[0]!;
    expect(p0.path).toBe('persona.md');
    expect(p0.kind).toBe('persona');
    expect(p0.proposed_content).toBe(newPersona);
    expect(p0.current_content).toContain('Warm, concise, business-casual.');
    expect(p0.diff_unified).toContain('--- persona.md');
    expect(p0.diff_unified).toContain('+++ persona.md');
    expect(p0.diff_unified).toContain('engineering contacts');
    expect(p0.rationale).toMatch(/concise/i);
    expect(result.summary).toContain('Adjusted persona voice');
  });

  it('handles multi-file proposals', async () => {
    const newPersona = '# Persona — Sam\n\n## Voice\n\nNew voice.\n';
    const newVerb = '# escalate\n\nDo the thing, concisely.\n';
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          { path: 'persona.md', new_content: newPersona, rationale: 'Reset voice section.' },
          {
            path: 'verbs/escalate.md',
            new_content: newVerb,
            rationale: 'Match the new voice in the escalate verb.',
          },
        ]),
      )
      .mockResolvedValueOnce(endTurnResponse('Adjusted persona and the escalate verb together.'));

    const result = await proposeChange(tempDir, { escalation_id: '2026-05-08-tone' });
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.map((p) => p.path)).toEqual(['persona.md', 'verbs/escalate.md']);
    expect(result.proposals[0]!.kind).toBe('persona');
    expect(result.proposals[1]!.kind).toBe('verb');
  });

  it('refuses constitutional lib targets via tool result and continues', async () => {
    // First turn: model proposes against lib/customers.yaml (refused) and persona.md (accepted).
    // Second turn: model retries the refused call against a non-gated lib path.
    // Third turn: end_turn with summary.
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            path: 'lib/customers.yaml',
            new_content: 'customers:\n  - acme\n',
            rationale: 'try gated',
          },
          {
            path: 'persona.md',
            new_content: '# Persona — Sam\n\nNew.\n',
            rationale: 'ok',
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            path: 'lib/team.yaml',
            new_content: 'team:\n  - sam\n',
            rationale: 'retry on safe lib',
          },
        ]),
      )
      .mockResolvedValueOnce(endTurnResponse('Adjusted persona and added team.yaml.'));

    const result = await proposeChange(tempDir, { escalation_id: '2026-05-08-tone' });
    // The refused proposal is dropped; the accepted ones survive.
    const paths = result.proposals.map((p) => p.path).sort();
    expect(paths).toEqual(['lib/team.yaml', 'persona.md']);
  });

  it('refuses if no proposals were accepted', async () => {
    createSpy.mockResolvedValueOnce(endTurnResponse('I did not propose anything.'));
    await expect(
      proposeChange(tempDir, { escalation_id: '2026-05-08-tone' }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses when the escalation does not exist', async () => {
    await expect(
      proposeChange(tempDir, { escalation_id: '2026-99-99-missing' }),
    ).rejects.toThrow(/Escalation not found/);
  });

  it('refuses a proposal that strips required frontmatter', async () => {
    await seedFile(
      'persona.md',
      '---\nname: Sam\n---\n\n# Persona — Sam\n\nVoice.\n',
    );
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            path: 'persona.md',
            new_content: '# Persona — Sam\n\nVoice with no frontmatter.\n',
            rationale: 'strip',
          },
        ]),
      )
      .mockResolvedValueOnce(endTurnResponse('done'));

    // The tool result returns is_error: true; with no surviving proposals
    // the propose call refuses overall.
    await expect(
      proposeChange(tempDir, { escalation_id: '2026-05-08-tone' }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('honours an operator hint in the prompt', async () => {
    createSpy
      .mockResolvedValueOnce(
        toolUseResponse([
          { path: 'persona.md', new_content: '# Persona\n\nNew.\n', rationale: 'r' },
        ]),
      )
      .mockResolvedValueOnce(endTurnResponse('ok'));

    await proposeChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      hint: 'Keep the existing greeting line.',
    });

    // The first messages.create call was the initial turn; inspect its user content.
    const firstCall = createSpy.mock.calls[0]?.[0] as { messages: { content: string }[] };
    const firstUser = firstCall.messages[0];
    const userContent = String(firstUser?.content ?? '');
    expect(userContent).toContain('Additional operator guidance');
    expect(userContent).toContain('Keep the existing greeting line.');
  });
});

describe('applyChange', () => {
  beforeEach(async () => {
    await initRepo();
    await seedEscalation(
      '2026-05-08-tone',
      `---\nkind: improvement\nurgency: normal\ncreated: 2026-05-08\nstatus: accepted\n---\n\n# Voice too formal\n\nbody`,
    );
    await seedFile(
      'persona.md',
      '---\nname: Sam\n---\n\n# Persona — Sam\n\nOriginal voice.\n',
    );
    await seedFile('verbs/escalate.md', '# escalate\n\nOriginal body.\n');
    // Stage and commit the seed so subsequent applies have a clean working tree.
    const git = simpleGit(tempDir);
    await git.add([
      'persona.md',
      'verbs/escalate.md',
      'escalations/2026-05-08-tone.md',
    ]);
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

  it('writes a single file and creates one operator commit with the Co-Authored-By trailer', async () => {
    const proposed =
      '---\nname: Sam\n---\n\n# Persona — Sam\n\nOriginal voice. Concise mode for engineering.\n';
    const result = await applyChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      proposals: [{ path: 'persona.md', proposed_content: proposed }],
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_short_sha).toMatch(/^[0-9a-f]{7}$/);
    expect(result.files_changed).toEqual(['persona.md']);

    const onDisk = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');
    expect(onDisk).toBe(proposed);

    const git = simpleGit(tempDir);
    const log = await git.raw(['log', '-n', '1', '--pretty=format:%an|%ae|%s|%b']);
    const [authorName, authorEmail, subject, body] = log.split('|');
    expect(authorName).toBe('Test Operator');
    expect(authorEmail).toBe('op@example.test');
    expect(subject).toMatch(/^operator\(persona\): apply proposal /);
    expect(body).toContain('Co-Authored-By: Praxis Role <role@praxis.local>');
    expect(body).toContain('2026-05-08-tone');
  });

  it('writes multiple files atomically in one commit', async () => {
    const newPersona = '---\nname: Sam\n---\n\n# Persona — Sam\n\nNew voice.\n';
    const newVerb = '# escalate\n\nNew body.\n';
    const result = await applyChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      proposals: [
        { path: 'persona.md', proposed_content: newPersona },
        { path: 'verbs/escalate.md', proposed_content: newVerb },
      ],
    });
    expect(result.files_changed).toEqual(['persona.md', 'verbs/escalate.md']);
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);

    const git = simpleGit(tempDir);
    const filesInCommit = (
      await git.raw(['show', '--name-only', '--pretty=format:', result.commit_sha])
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
    expect(filesInCommit).toEqual(['persona.md', 'verbs/escalate.md']);

    // Mixed-kind commit uses the generic coauthor scope.
    const subject = (await git.raw(['log', '-n', '1', '--pretty=format:%s'])).trim();
    expect(subject).toMatch(/^operator\(coauthor\):/);
  });

  it('refuses path traversal on any proposal', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [
          { path: 'persona.md', proposed_content: 'ok' },
          { path: '../etc/passwd', proposed_content: 'pwn' },
        ],
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses a target_path off the allowlist', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [{ path: 'memory/notes/foo.md', proposed_content: 'whatever' }],
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses constitutional lib paths', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [
          { path: 'lib/customers.yaml', proposed_content: 'customers: []\n' },
        ],
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses a frontmatter-stripping change', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [
          {
            path: 'persona.md',
            proposed_content: '# Persona — Sam\n\nNo frontmatter here.\n',
          },
        ],
      }),
    ).rejects.toThrow(/frontmatter/);
  });

  it('refuses duplicate paths in the proposal set', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [
          {
            path: 'persona.md',
            proposed_content: '---\nname: Sam\n---\n\nA\n',
          },
          {
            path: 'persona.md',
            proposed_content: '---\nname: Sam\n---\n\nB\n',
          },
        ],
      }),
    ).rejects.toThrow(/Duplicate/);
  });

  it('refuses when the escalation does not exist', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: 'missing',
        proposals: [
          {
            path: 'persona.md',
            proposed_content: '---\nname: Sam\n---\n\nnew\n',
          },
        ],
      }),
    ).rejects.toThrow(/Escalation not found/);
  });

  it('allows creating a new lib file when none exists', async () => {
    const proposed = 'tags:\n  - sample\n';
    const result = await applyChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      proposals: [{ path: 'lib/new.yaml', proposed_content: proposed }],
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const onDisk = await fs.readFile(path.join(tempDir, 'lib', 'new.yaml'), 'utf-8');
    expect(onDisk).toBe(proposed);
  });

  it('reverts already-written files on partial write failure', async () => {
    // Force the second write to fail by removing write permission on the
    // verbs/escalate.md file's directory mid-flight is awkward in a portable
    // test — instead, craft a proposal where the second path is unwritable
    // by writing to a deeply-nested path with a name that exists as a file
    // (so mkdir -p hits ENOTDIR). We create a sentinel "lib/blocker" file,
    // then try to apply [persona.md, lib/blocker/inner.yaml] — the second
    // write fails, and we expect persona.md to be reverted to its prior
    // contents.
    await fs.writeFile(path.join(tempDir, 'lib', 'blocker'), 'I am a file\n', 'utf-8');
    const personaBefore = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');

    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        proposals: [
          {
            path: 'persona.md',
            proposed_content: '---\nname: Sam\n---\n\n# Persona — Sam\n\nChanged.\n',
          },
          { path: 'lib/blocker/inner.yaml', proposed_content: 'x: 1\n' },
        ],
      }),
    ).rejects.toThrow();

    const personaAfter = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');
    expect(personaAfter).toBe(personaBefore);
  });
});
