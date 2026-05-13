import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeRunVerb, stripFrontmatter } from './run-verb.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-run-verb-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function initRepoWithBaseline(): Promise<void> {
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.name', 'Operator', false, 'local');
  await git.addConfig('user.email', 'op@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  await git.add('persona.md');
  await git.raw([
    '-c',
    'user.name=Operator',
    '-c',
    'user.email=op@example.test',
    'commit',
    '--author=Operator <op@example.test>',
    '--no-gpg-sign',
    '-m',
    'init',
  ]);
}

async function seedLiveVerb(slug: string, content: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'verbs', `${slug}.md`), content, 'utf-8');
}

async function seedProposedVerb(slug: string, content: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, 'verbs', 'proposed', `${slug}.md`),
    content,
    'utf-8',
  );
}

async function readTodayLogLines(now: Date): Promise<Record<string, unknown>[]> {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const file = path.join(tempDir, 'logs', `${yyyy}-${mm}-${dd}.jsonl`);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('stripFrontmatter', () => {
  it('returns the whole text when there is no frontmatter', () => {
    const { description, body } = stripFrontmatter('# Hello\n\nbody.');
    expect(description).toBeUndefined();
    expect(body).toBe('# Hello\n\nbody.');
  });

  it('strips a leading YAML block and pulls description', () => {
    const text = '---\ndescription: weekly read of the customer portfolio\nstatus: live\n---\n\n# Account Read\n\nSteps...';
    const { description, body } = stripFrontmatter(text);
    expect(description).toBe('weekly read of the customer portfolio');
    expect(body).not.toMatch(/^---/);
    expect(body).toContain('# Account Read');
    expect(body).toContain('Steps...');
  });

  it('returns undefined description when the frontmatter omits it', () => {
    const text = '---\nstatus: live\n---\n\n# x\n';
    const { description, body } = stripFrontmatter(text);
    expect(description).toBeUndefined();
    expect(body).not.toMatch(/^---/);
    expect(body).toContain('# x');
  });

  it('strips wrapping single quotes from description values', () => {
    const text = "---\ndescription: 'something with: a colon'\n---\n\nbody\n";
    const { description } = stripFrontmatter(text);
    expect(description).toBe('something with: a colon');
  });
});

describe('executeRunVerb', () => {
  it('refuses invalid slug shape', async () => {
    const r = await executeRunVerb(tempDir, { slug: 'NotKebabCase' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/run_verb input invalid/);
  });

  it('refuses when no live verb exists', async () => {
    const r = await executeRunVerb(tempDir, { slug: 'mystery' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no live verb at verbs\/mystery\.md/);
  });

  it('refuses when the verb is only proposed', async () => {
    await seedProposedVerb('experimental', '# experimental\n\nbody');
    const r = await executeRunVerb(tempDir, { slug: 'experimental' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/exists only as a proposal/);
      expect(r.error).toMatch(/verbs\/proposed\/experimental\.md/);
    }
  });

  it('returns the body and description on the happy path with frontmatter', async () => {
    await seedLiveVerb(
      'account-read',
      '---\ndescription: weekly read of the customer portfolio\n---\n\n# Account Read\n\nSteps to follow.\n',
    );
    const now = new Date(2026, 4, 13, 9, 30, 15);
    const r = await executeRunVerb(tempDir, { slug: 'account-read' }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['slug']).toBe('account-read');
    expect(r.data['description']).toBe('weekly read of the customer portfolio');
    const body = r.data['body'] as string;
    expect(body).not.toMatch(/^---/);
    expect(body).toMatch(/# Account Read/);
    expect(body).toContain('Steps to follow.');
    expect(r.summary).toMatch(/^started verb account-read/);
  });

  it('returns the whole body when the verb has no frontmatter', async () => {
    await seedLiveVerb('plain-verb', '# Plain\n\nNo frontmatter here.\n');
    const now = new Date(2026, 4, 13, 9, 30, 15);
    const r = await executeRunVerb(tempDir, { slug: 'plain-verb' }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['description']).toBeUndefined();
    expect((r.data['body'] as string).startsWith('# Plain')).toBe(true);

    // And the activity entry omits the description field rather than carrying
    // an explicit `null` — keeps the JSONL row tight when there's nothing to
    // record.
    const lines = await readTodayLogLines(now);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['description']).toBeUndefined();
  });

  it('appends a verb_started JSONL line with the conventional fields', async () => {
    await seedLiveVerb(
      'account-read',
      '---\ndescription: weekly read of the customer portfolio\n---\n\n# x\n',
    );
    const now = new Date(2026, 4, 13, 9, 30, 15);
    await executeRunVerb(tempDir, { slug: 'account-read' }, now);

    const lines = await readTodayLogLines(now);
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry['agent']).toBe('chat');
    expect(entry['action']).toBe('verb_started');
    expect(entry['verb']).toBe('account-read');
    expect(entry['description']).toBe('weekly read of the customer portfolio');
    expect(entry['headline']).toBe('start: account-read');
    expect(entry['timestamp']).toMatch(/^2026-05-13T09:30:15[+-]\d{2}:\d{2}$/);
    // No `tool` field — this is action: verb_started, not tool_call.
    expect(entry['tool']).toBeUndefined();
  });

  it('commits the activity line as role(verb): start <slug>', async () => {
    await initRepoWithBaseline();
    await seedLiveVerb('account-read', '# Account Read\n\nbody\n');
    const now = new Date(2026, 4, 13, 9, 30, 15);
    const r = await executeRunVerb(tempDir, { slug: 'account-read' }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect((r.data['commit_short_sha'] as string)).toMatch(/^[0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s',
    ]);
    const [author, subject] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    // After the verb seed write (which isn't committed by the tool itself —
    // the operator owns verb files), only the activity append should be in
    // the latest commit.
    expect(subject).toBe('role(verb): start account-read');
  });
});
