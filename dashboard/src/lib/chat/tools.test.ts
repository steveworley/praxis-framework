import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executeCreateEscalation,
  executeLogDecision,
  executeProposeVerb,
  executeTool,
  executeWriteMemory,
  slugify,
} from './tools.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-tools-'));
  // Touch persona.md so any future role-rooted helpers find the marker.
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugify('Mary Chen at Acme')).toBe('mary-chen-at-acme');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('--Foo Bar!--')).toBe('foo-bar');
  });

  it('returns empty for purely-punctuation input', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('executeWriteMemory', () => {
  it('refuses invalid input shape', async () => {
    const r = await executeWriteMemory(tempDir, { category: 'people' });
    expect(r.ok).toBe(false);
  });

  it('refuses categories with uppercase letters', async () => {
    const r = await executeWriteMemory(tempDir, {
      category: 'People',
      title: 'x',
      body: 'y',
    });
    expect(r.ok).toBe(false);
  });

  it('writes a slugified file with frontmatter and H1', async () => {
    const r = await executeWriteMemory(tempDir, {
      category: 'people',
      title: 'Mary Chen at Acme',
      body: 'She prefers async updates.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('memory/people/mary-chen-at-acme.md');

    const written = await fs.readFile(
      path.join(tempDir, 'memory/people/mary-chen-at-acme.md'),
      'utf-8',
    );
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/title: Mary Chen at Acme/);
    expect(written).toMatch(/^# Mary Chen at Acme$/m);
    expect(written).toContain('She prefers async updates.');
  });

  it('refuses to overwrite an existing file', async () => {
    await executeWriteMemory(tempDir, {
      category: 'people',
      title: 'Mary',
      body: 'first',
    });
    const r = await executeWriteMemory(tempDir, {
      category: 'people',
      title: 'Mary',
      body: 'second',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });

  it('refuses gated categories via autonomy gate', async () => {
    // Category that path-resolves into a constitutional file? Not reachable —
    // memory/ is implicit-autonomous. Instead, verify that a category with
    // traversal characters is rejected by the regex.
    const r = await executeWriteMemory(tempDir, {
      category: '../lib',
      title: 'x',
      body: 'y',
    });
    expect(r.ok).toBe(false);
  });

  it('creates the category directory if it does not yet exist', async () => {
    const r = await executeWriteMemory(tempDir, {
      category: 'contracts',
      title: 'Acme MSA renewal',
      body: 'Notes',
    });
    expect(r.ok).toBe(true);
    const dir = await fs.stat(path.join(tempDir, 'memory/contracts'));
    expect(dir.isDirectory()).toBe(true);
  });
});

describe('executeCreateEscalation', () => {
  it('refuses unknown kinds', async () => {
    const r = await executeCreateEscalation(tempDir, {
      kind: 'stuck',
      summary: 's',
      body: 'b',
    });
    expect(r.ok).toBe(false);
  });

  it('writes a file with date-prefixed id, frontmatter, status open', async () => {
    const r = await executeCreateEscalation(
      tempDir,
      {
        kind: 'improvement',
        summary: 'Pricing question repeats',
        body: 'What I was doing\n...\n',
      },
      new Date('2026-05-12T10:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rel = r.data['path'] as string;
    expect(rel.startsWith('escalations/2026-05-12-')).toBe(true);
    expect(rel.endsWith('-pricing-question-repeats.md')).toBe(true);

    const text = await fs.readFile(path.join(tempDir, rel), 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toMatch(/kind: improvement/);
    expect(text).toMatch(/status: open/);
    expect(text).toMatch(/agent_context: chat/);
    expect(text).toMatch(/urgency: normal/);
    expect(text).toMatch(/^# Pricing question repeats$/m);
  });

  it('defaults urgency to normal and agent_context to chat', async () => {
    const r = await executeCreateEscalation(tempDir, {
      kind: 'help',
      summary: 'stuck',
      body: 'help me',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = await fs.readFile(path.join(tempDir, r.data['path'] as string), 'utf-8');
    expect(text).toMatch(/urgency: normal/);
    expect(text).toMatch(/agent_context: chat/);
  });

  it('includes proposed_skill in frontmatter when supplied', async () => {
    const r = await executeCreateEscalation(tempDir, {
      kind: 'proposed_skill',
      summary: 'New verb idea',
      body: 'see draft',
      proposed_skill_path: 'verbs/proposed/foo.md',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = await fs.readFile(path.join(tempDir, r.data['path'] as string), 'utf-8');
    expect(text).toMatch(/proposed_skill: verbs\/proposed\/foo\.md/);
  });
});

describe('executeProposeVerb', () => {
  it('refuses slugs with uppercase', async () => {
    const r = await executeProposeVerb(tempDir, {
      slug: 'NewVerb',
      description: 'd',
      body: 'b',
    });
    expect(r.ok).toBe(false);
  });

  it('writes the draft into verbs/proposed/', async () => {
    const r = await executeProposeVerb(tempDir, {
      slug: 'follow-up-cadence',
      description: 'Track follow-up cadence',
      body: '# Follow-up cadence\n\nSteps...',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('verbs/proposed/follow-up-cadence.md');
    const text = await fs.readFile(
      path.join(tempDir, 'verbs/proposed/follow-up-cadence.md'),
      'utf-8',
    );
    expect(text).toMatch(/description: Track follow-up cadence/);
    expect(text).toMatch(/status: proposed/);
  });

  it('refuses if the slug exists in verbs/ already', async () => {
    await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'verbs/escalate.md'), '# Escalate', 'utf-8');
    const r = await executeProposeVerb(tempDir, {
      slug: 'escalate',
      description: 'duplicate',
      body: 'b',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });

  it('refuses if the slug exists in verbs/proposed/ already', async () => {
    await fs.mkdir(path.join(tempDir, 'verbs/proposed'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'verbs/proposed/duplicate.md'),
      '# Duplicate',
      'utf-8',
    );
    const r = await executeProposeVerb(tempDir, {
      slug: 'duplicate',
      description: 'duplicate again',
      body: 'b',
    });
    expect(r.ok).toBe(false);
  });
});

describe('executeLogDecision', () => {
  it('refuses without rationale', async () => {
    const r = await executeLogDecision(tempDir, {
      decision_type: 'qualification_verdict',
      chosen: 'qualified',
    });
    expect(r.ok).toBe(false);
  });

  it('writes a JSONL line to logs/<date>.jsonl', async () => {
    const now = new Date('2026-05-12T10:00:00Z');
    const r = await executeLogDecision(
      tempDir,
      {
        decision_type: 'qualification_verdict',
        chosen: 'qualified',
        rationale: 'budget signal in transcript',
        considered: ['skipped', 'qualified'],
        confidence: 'high',
      },
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const file = await fs.readFile(
      path.join(tempDir, r.data['path'] as string),
      'utf-8',
    );
    const line = file.trim();
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed['action']).toBe('decision');
    expect(parsed['agent']).toBe('chat');
    expect(parsed['decision_type']).toBe('qualification_verdict');
    expect(parsed['rationale']).toBe('budget signal in transcript');
    expect(parsed['considered']).toBe('skipped, qualified');
    expect(parsed['confidence']).toBe('high');
    expect(parsed['timestamp']).toMatch(/^2026-05-12T/);
  });

  it('appends to existing logs (does not overwrite)', async () => {
    const now = new Date('2026-05-12T10:00:00Z');
    await executeLogDecision(
      tempDir,
      { decision_type: 'a', chosen: 'x', rationale: 'r' },
      now,
    );
    await executeLogDecision(
      tempDir,
      { decision_type: 'b', chosen: 'y', rationale: 'r' },
      now,
    );
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const lines = file.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('lands inside campaigns/<id>/logs/ when campaign is supplied', async () => {
    await fs.mkdir(path.join(tempDir, 'campaigns/q1'), { recursive: true });
    const now = new Date('2026-05-12T10:00:00Z');
    const r = await executeLogDecision(
      tempDir,
      {
        decision_type: 'angle_choice',
        chosen: 'lead with metrics',
        rationale: 'audience is finance',
        campaign: 'q1',
      },
      now,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('campaigns/q1/logs/2026-05-12.jsonl');
  });

  it('refuses unknown campaigns', async () => {
    const r = await executeLogDecision(tempDir, {
      decision_type: 'x',
      chosen: 'y',
      rationale: 'r',
      campaign: 'does-not-exist',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/campaign directory does not exist/);
  });
});

describe('executeTool dispatch', () => {
  it('refuses unknown tool names', async () => {
    const r = await executeTool('do_anything', {}, tempDir);
    expect(r.ok).toBe(false);
  });

  it('routes write_memory through the dispatcher', async () => {
    const r = await executeTool(
      'write_memory',
      { category: 'notes', title: 'a note', body: 'body' },
      tempDir,
    );
    expect(r.ok).toBe(true);
  });

  it('routes archive_memory through the dispatcher', async () => {
    await executeWriteMemory(tempDir, {
      category: 'notes',
      title: 'archivable',
      body: 'body',
    });
    const r = await executeTool('archive_memory', { slug: 'archivable' }, tempDir);
    expect(r.ok).toBe(true);
  });
});

describe('audit-log commits on tool calls', () => {
  /**
   * For these tests we pre-seed a git repo at the role home with a baseline
   * commit, then run a tool. The audit module attaches the new commit SHA
   * onto `result.data.commit_sha`, attributed to `Praxis Role`.
   */
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

  it('write_memory commits with role attribution', async () => {
    await initRepoWithBaseline();
    const r = await executeWriteMemory(tempDir, {
      category: 'people',
      title: 'Mary Chen',
      body: 'prefers async',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sha = r.data['commit_sha'];
    expect(typeof sha).toBe('string');
    expect((sha as string).length).toBeGreaterThan(7);
    expect(r.data['commit_short_sha']).toMatch(/^[0-9a-f]{7}$/);
    expect(r.summary).toMatch(/^wrote memory\/people\/mary-chen\.md · [0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw(['log', '-n', '1', '--pretty=format:%an <%ae>%x1f%s']);
    const [author, subject] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(memory): note mary-chen');
  });

  it('create_escalation commits with role attribution', async () => {
    await initRepoWithBaseline();
    const r = await executeCreateEscalation(
      tempDir,
      {
        kind: 'improvement',
        summary: 'pricing question repeats',
        body: 'we keep being asked about it',
      },
      new Date('2026-05-12T10:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');

    const git = simpleGit(tempDir);
    const subject = (
      await git.raw(['log', '-n', '1', '--pretty=format:%s'])
    ).trim();
    expect(subject).toBe('role(escalation): file improvement — pricing-question-repeats');
  });

  it('propose_verb commits with role attribution', async () => {
    await initRepoWithBaseline();
    const r = await executeProposeVerb(tempDir, {
      slug: 'follow-up-cadence',
      description: 'Track follow-up cadence',
      body: '# Follow-up cadence',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');

    const git = simpleGit(tempDir);
    const subject = (
      await git.raw(['log', '-n', '1', '--pretty=format:%s'])
    ).trim();
    expect(subject).toBe('role(verb): propose follow-up-cadence');
  });

  it('log_decision commits with role attribution', async () => {
    await initRepoWithBaseline();
    const r = await executeLogDecision(
      tempDir,
      {
        decision_type: 'qualification_verdict',
        chosen: 'qualified',
        rationale: 'budget signal',
        confidence: 'high',
      },
      new Date('2026-05-12T10:00:00Z'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');

    const git = simpleGit(tempDir);
    const log = await git.raw(['log', '-n', '1', '--pretty=format:%s%x1f%b']);
    const [subject, body] = log.split('\x1f');
    expect(subject).toBe('role(decision): log qualification_verdict');
    expect(body).toContain('Chosen: qualified');
    expect(body).toContain('Confidence: high');
  });
});
