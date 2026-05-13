import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emitToolActivity, headlineFor } from './activity-emitter.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-activity-emit-'));
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

describe('emitToolActivity', () => {
  it('writes a JSONL entry with the conventional fields', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'write_memory',
      { path: 'memory/people/mary.md', created: '2026-05-12' },
      now,
    );

    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const line = file.trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['agent']).toBe('chat');
    expect(parsed['action']).toBe('tool_call');
    expect(parsed['tool']).toBe('write_memory');
    expect(parsed['path']).toBe('memory/people/mary.md');
    expect(parsed['created']).toBe('2026-05-12');
    expect(parsed['timestamp']).toMatch(/^2026-05-12T09:30:15[+-]\d{2}:\d{2}$/);
  });

  it('appends to existing logs rather than overwriting (idempotent file growth)', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(tempDir, 'write_memory', { path: 'a' }, now);
    await emitToolActivity(tempDir, 'create_escalation', { path: 'b' }, now);

    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const lines = file.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first['tool']).toBe('write_memory');
    expect(second['tool']).toBe('create_escalation');
  });

  it('refuses to shadow conventional fields supplied in payload', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'write_memory',
      {
        // Caller accidentally supplied a duplicate `agent` / `action` — the
        // emitter must keep the canonical values it stamped.
        agent: 'evil',
        action: 'evil',
        tool: 'evil',
        path: 'memory/people/x.md',
      },
      now,
    );
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed['agent']).toBe('chat');
    expect(parsed['action']).toBe('tool_call');
    expect(parsed['tool']).toBe('write_memory');
    expect(parsed['path']).toBe('memory/people/x.md');
  });

  it('commits the appended line as role(activity): log tool_call <name>', async () => {
    await initRepoWithBaseline();
    const now = new Date(2026, 4, 12, 9, 30, 15);
    const commit = await emitToolActivity(
      tempDir,
      'write_memory',
      { path: 'memory/people/mary.md' },
      now,
    );
    expect(commit.committed).toBe(true);
    expect(typeof commit.sha).toBe('string');
    expect(commit.shortSha).toMatch(/^[0-9a-f]{7}$/);

    const git = simpleGit(tempDir);
    const log = await git.raw([
      'log',
      '-n',
      '1',
      '--pretty=format:%an <%ae>%x1f%s',
    ]);
    const [author, subject] = log.split('\x1f');
    expect(author).toBe('Praxis Role <role@praxis.local>');
    expect(subject).toBe('role(activity): log tool_call write_memory');
  });

  it('creates the logs directory if it does not yet exist', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(tempDir, 'write_memory', { path: 'x' }, now);
    const stat = await fs.stat(path.join(tempDir, 'logs'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('stamps a derived headline on each tool_call entry', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'write_memory',
      { path: 'memory/notes/leading-a-sales-organisation.md', created: '2026-05-12' },
      now,
    );
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed['headline']).toBe('note leading-a-sales-organisation');
    // Field-order contract: headline sits between `tool` and the payload tail.
    const keys = Object.keys(parsed);
    expect(keys.slice(0, 5)).toEqual([
      'timestamp',
      'agent',
      'action',
      'tool',
      'headline',
    ]);
  });

  it('falls back to the tool name when required headline fields are missing', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(tempDir, 'write_memory', {}, now);
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed['headline']).toBe('write_memory');
  });

  it('keeps the emitter-derived headline even if the payload carries one', async () => {
    const now = new Date(2026, 4, 12, 9, 30, 15);
    await emitToolActivity(
      tempDir,
      'propose_verb',
      { slug: 'qualify-deal', headline: 'evil' },
      now,
    );
    const file = await fs.readFile(
      path.join(tempDir, 'logs', '2026-05-12.jsonl'),
      'utf-8',
    );
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed['headline']).toBe('propose qualify-deal');
  });
});

describe('headlineFor', () => {
  it('derives a slug from path for write_memory', () => {
    expect(
      headlineFor('write_memory', {
        path: 'memory/notes/leading-a-sales-organisation.md',
      }),
    ).toBe('note leading-a-sales-organisation');
  });

  it('derives a slug from source_path for archive_memory', () => {
    expect(
      headlineFor('archive_memory', {
        source_path: 'memory/people/mary.md',
        archived_path: 'memory/archived/people/mary.md',
      }),
    ).toBe('archive mary');
  });

  it('formats consolidate_memory with archived count and new slug', () => {
    expect(
      headlineFor('consolidate_memory', {
        new_slug: 'q3-account-themes',
        new_path: 'memory/notes/q3-account-themes.md',
        archived: [
          'memory/archived/notes/a.md',
          'memory/archived/notes/b.md',
          'memory/archived/notes/c.md',
        ],
      }),
    ).toBe('consolidate 3 entries → q3-account-themes');
  });

  it('formats create_escalation with kind and id', () => {
    expect(
      headlineFor('create_escalation', {
        path: 'escalations/2026-05-12-ab12-help-with-x.md',
        id: '2026-05-12-ab12-help-with-x',
        kind: 'help',
      }),
    ).toBe('file help — 2026-05-12-ab12-help-with-x');
  });

  it('formats propose_verb with the slug', () => {
    expect(
      headlineFor('propose_verb', {
        slug: 'qualify-deal',
        path: 'verbs/proposed/qualify-deal.md',
      }),
    ).toBe('propose qualify-deal');
  });

  it('formats append_entry with the relative path (no extension)', () => {
    expect(
      headlineFor('append_entry', {
        path: 'lib/customers.yaml',
        count: 7,
        root_key: 'customers',
      }),
    ).toBe('append to lib/customers');
  });

  it('formats enrich_entry with the relative path (no extension)', () => {
    expect(
      headlineFor('enrich_entry', {
        path: 'lib/customers.yaml',
        entry_id: 'acme.test',
        fields_updated: ['arr_band'],
        root_key: 'customers',
        unique_by: 'domain',
      }),
    ).toBe('enrich lib/customers');
  });

  it('formats adjust_param with the key and relative path', () => {
    expect(
      headlineFor('adjust_param', {
        path: 'lib/cadence.yaml',
        key: 'sends_per_day',
        new_value: 12,
        previous_value: 10,
      }),
    ).toBe('adjust sends_per_day on lib/cadence');
  });

  it('formats write_output with type and slug', () => {
    expect(
      headlineFor('write_output', {
        path: 'outputs/note/standup-2026-05-12.md',
        type: 'note',
        slug: 'standup-2026-05-12',
        status: 'draft',
      }),
    ).toBe('write note: standup-2026-05-12');
  });

  it('formats update_output_status with the new status and relative path', () => {
    expect(
      headlineFor('update_output_status', {
        path: 'outputs/note/standup-2026-05-12.md',
        type: 'note',
        slug: 'standup-2026-05-12',
        status: 'sent',
        previous_status: 'draft',
      }),
    ).toBe('sent: outputs/note/standup-2026-05-12');
  });

  it('falls back to the tool name when fields are missing', () => {
    // Each branch must degrade rather than throw when its required fields
    // aren't on the payload — the artifact already landed, so a degraded
    // headline is better than losing the audit row.
    const tools = [
      'write_memory',
      'archive_memory',
      'consolidate_memory',
      'create_escalation',
      'propose_verb',
      'append_entry',
      'enrich_entry',
      'adjust_param',
      'write_output',
      'update_output_status',
    ];
    for (const tool of tools) {
      expect(headlineFor(tool, {})).toBe(tool);
    }
  });

  it('falls back to the tool name for unknown tools', () => {
    expect(headlineFor('mystery_tool', { path: 'x' })).toBe('mystery_tool');
  });

  it('formats MCP tool names as `mcp: <server>.<method>`', () => {
    expect(headlineFor('slack__post_message', {})).toBe('mcp: slack.post_message');
    expect(headlineFor('gmail__send', { recipient: 'x' })).toBe('mcp: gmail.send');
  });

  it('handles MCP method names containing additional underscores', () => {
    expect(headlineFor('playwright__browser_click', {})).toBe(
      'mcp: playwright.browser_click',
    );
  });

  it('narrows defensively against non-string payload fields', () => {
    // Payload values arrive as `unknown` — non-string `path` must not slip
    // through to path manipulation and surface a "[object Object]" headline.
    expect(
      headlineFor('write_memory', { path: { not: 'a string' } }),
    ).toBe('write_memory');
    expect(
      headlineFor('consolidate_memory', { new_slug: 'x', archived: 'nope' }),
    ).toBe('consolidate_memory');
  });
});
