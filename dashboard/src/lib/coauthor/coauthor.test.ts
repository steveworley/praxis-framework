import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CoauthorNotFoundError,
  CoauthorValidationError,
  applyChange,
  draftChange,
  resolveTargetPath,
} from './index.ts';

// Mock the Anthropic SDK at the module boundary so we can shape the draft call
// deterministically. Mirrors dashboard/src/lib/chat/anthropic.test.ts.
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

describe('resolveTargetPath', () => {
  it('maps persona to persona.md', () => {
    expect(resolveTargetPath({ kind: 'persona' })).toBe('persona.md');
  });

  it('maps claude-md to CLAUDE.md', () => {
    expect(resolveTargetPath({ kind: 'claude-md' })).toBe('CLAUDE.md');
  });

  it('maps verb slug to verbs/<slug>.md', () => {
    expect(resolveTargetPath({ kind: 'verb', slug: 'escalate' })).toBe('verbs/escalate.md');
  });

  it('refuses an invalid verb slug', () => {
    expect(() => resolveTargetPath({ kind: 'verb', slug: 'Bad Slug' })).toThrow(
      CoauthorValidationError,
    );
  });

  it('maps lib filename to lib/<filename>', () => {
    expect(resolveTargetPath({ kind: 'lib', filename: 'team.yaml' })).toBe('lib/team.yaml');
  });

  it('refuses lib filename with a path separator', () => {
    expect(() => resolveTargetPath({ kind: 'lib', filename: '../etc/passwd' })).toThrow(
      CoauthorValidationError,
    );
    expect(() => resolveTargetPath({ kind: 'lib', filename: 'sub/file.yaml' })).toThrow(
      CoauthorValidationError,
    );
  });

  it('refuses lib filename with an unexpected extension', () => {
    expect(() => resolveTargetPath({ kind: 'lib', filename: 'file.sh' })).toThrow(
      CoauthorValidationError,
    );
  });
});

describe('draftChange', () => {
  beforeEach(async () => {
    await seedEscalation(
      '2026-05-08-tone',
      `---\nkind: improvement\nurgency: normal\ncreated: 2026-05-08\nstatus: accepted\n---\n\n# Voice too formal for engineering contacts\n\nI keep falling back to corporate tone when emailing engineers.`,
    );
    await seedFile('persona.md', '# Persona — Sam\n\n## Voice\n\nWarm, concise, business-casual.\n');
  });

  it('returns the proposed content, unified diff, and target path', async () => {
    const newPersona =
      '# Persona — Sam\n\n## Voice\n\nWarm, concise, business-casual. When talking to engineering contacts, lean concise — short paragraphs, no flourish.';
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: `${newPersona}\n` }],
      stop_reason: 'end_turn',
    });

    const result = await draftChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      target: { kind: 'persona' },
      directive: 'Add a concise mode for engineering contacts.',
    });

    expect(result.target_path).toBe('persona.md');
    expect(result.proposed_content).toBe(newPersona);
    expect(result.current_content).toContain('Warm, concise, business-casual.');
    expect(result.diff_unified).toContain('--- persona.md');
    expect(result.diff_unified).toContain('+++ persona.md');
    expect(result.diff_unified).toContain('engineering contacts');
    expect(result.rationale).toBe('');
  });

  it('strips a fenced wrapper from the model output', async () => {
    createSpy.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```markdown\n# Persona — Sam\n\nNew body.\n```\n',
        },
      ],
      stop_reason: 'end_turn',
    });
    const result = await draftChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      target: { kind: 'persona' },
      directive: 'Rewrite the voice.',
    });
    expect(result.proposed_content).toBe('# Persona — Sam\n\nNew body.');
  });

  it('refuses when the escalation does not exist', async () => {
    await expect(
      draftChange(tempDir, {
        escalation_id: '2026-99-99-missing',
        target: { kind: 'persona' },
        directive: 'something',
      }),
    ).rejects.toThrow(/Escalation not found/);
  });

  it('refuses when the persona file is missing', async () => {
    await fs.rm(path.join(tempDir, 'persona.md'));
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'never reached' }],
      stop_reason: 'end_turn',
    });
    await expect(
      draftChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        target: { kind: 'persona' },
        directive: 'something',
      }),
    ).rejects.toBeInstanceOf(CoauthorNotFoundError);
  });

  it('tolerates a missing lib file (creation flow)', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tags:\n  - sample\n' }],
      stop_reason: 'end_turn',
    });
    const result = await draftChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      target: { kind: 'lib', filename: 'new.yaml' },
      directive: 'Create a new tags file.',
    });
    expect(result.target_path).toBe('lib/new.yaml');
    expect(result.current_content).toBe('');
    expect(result.proposed_content).toContain('tags:');
  });
});

describe('applyChange', () => {
  beforeEach(async () => {
    await initRepo();
    await seedEscalation(
      '2026-05-08-tone',
      `---\nkind: improvement\nurgency: normal\ncreated: 2026-05-08\nstatus: accepted\n---\n\n# Voice too formal\n\nbody`,
    );
    await seedFile('persona.md', '---\nname: Sam\n---\n\n# Persona — Sam\n\nOriginal voice.\n');
    // Stage and commit the seed so subsequent applies have a clean working tree.
    const git = simpleGit(tempDir);
    await git.add(['persona.md', 'escalations/2026-05-08-tone.md']);
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

  it('writes the file and creates an operator commit with the Co-Authored-By trailer', async () => {
    const proposed =
      '---\nname: Sam\n---\n\n# Persona — Sam\n\nOriginal voice. Concise mode for engineering.\n';
    const result = await applyChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      target_path: 'persona.md',
      proposed_content: proposed,
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_short_sha).toMatch(/^[0-9a-f]{7}$/);

    const onDisk = await fs.readFile(path.join(tempDir, 'persona.md'), 'utf-8');
    expect(onDisk).toBe(proposed);

    const git = simpleGit(tempDir);
    const log = await git.raw(['log', '-n', '1', '--pretty=format:%an|%ae|%s|%b']);
    const [authorName, authorEmail, subject, body] = log.split('|');
    expect(authorName).toBe('Test Operator');
    expect(authorEmail).toBe('op@example.test');
    expect(subject).toMatch(/^operator\(persona\): co-author /);
    expect(body).toContain('Co-Authored-By: Praxis Role <role@praxis.local>');
    expect(body).toContain('2026-05-08-tone');
  });

  it('refuses a path traversal in target_path', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        target_path: '../etc/passwd',
        proposed_content: 'pwned',
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses a target_path that is not on the allowlist', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        target_path: 'memory/notes/foo.md',
        proposed_content: 'whatever',
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses a frontmatter-stripping change when the original has frontmatter', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        target_path: 'persona.md',
        proposed_content: '# Persona — Sam\n\nNo frontmatter here.\n',
      }),
    ).rejects.toThrow(/frontmatter/);
  });

  it('refuses empty proposed content', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: '2026-05-08-tone',
        target_path: 'persona.md',
        proposed_content: '',
      }),
    ).rejects.toBeInstanceOf(CoauthorValidationError);
  });

  it('refuses when the escalation does not exist', async () => {
    await expect(
      applyChange(tempDir, {
        escalation_id: 'missing',
        target_path: 'persona.md',
        proposed_content: '---\nname: Sam\n---\n\nnew\n',
      }),
    ).rejects.toThrow(/Escalation not found/);
  });

  it('allows creating a new lib file when none exists', async () => {
    const proposed = 'tags:\n  - sample\n';
    const result = await applyChange(tempDir, {
      escalation_id: '2026-05-08-tone',
      target_path: 'lib/new.yaml',
      proposed_content: proposed,
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const onDisk = await fs.readFile(path.join(tempDir, 'lib', 'new.yaml'), 'utf-8');
    expect(onDisk).toBe(proposed);
  });
});
