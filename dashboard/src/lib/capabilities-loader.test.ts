import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCapabilities } from './capabilities-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-capabilities-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeJsonl(dir: string, file: string, entries: Record<string, unknown>[]): Promise<void> {
  const abs = path.join(dir, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(abs, text, 'utf-8');
}

async function writeFile(dir: string, rel: string, body: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

describe('loadCapabilities — chat tools', () => {
  it('aggregates 30-day call counts and last-invoked across the four action shapes', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeJsonl(tempDir, 'logs/2026-05-13.jsonl', [
      // tool_call shape — counts under the named tool.
      { timestamp: '2026-05-13T07:48:00Z', action: 'tool_call', tool: 'write_memory' },
      { timestamp: '2026-05-12T07:48:00Z', action: 'tool_call', tool: 'write_memory' },
      { timestamp: '2026-05-13T08:00:00Z', action: 'tool_call', tool: 'archive_memory' },
      // decision shape — counts under log_decision.
      { timestamp: '2026-05-13T09:00:00Z', action: 'decision', decision_type: 'angle_choice' },
      // verb_started shape — counts under run_verb.
      { timestamp: '2026-05-13T09:30:00Z', action: 'verb_started', verb: 'escalate' },
      // verb_completed shape — counts under complete_verb.
      {
        timestamp: '2026-05-13T09:45:00Z',
        action: 'verb_completed',
        verb: 'escalate',
        outcome: 'success',
      },
    ]);

    const report = await loadCapabilities(tempDir, now);

    const byName = new Map(report.chatTools.map((t) => [t.name, t]));
    expect(byName.get('write_memory')?.callCount30d).toBe(2);
    expect(byName.get('write_memory')?.lastInvoked).toBe('2026-05-13T07:48:00Z');
    expect(byName.get('archive_memory')?.callCount30d).toBe(1);
    expect(byName.get('log_decision')?.callCount30d).toBe(1);
    expect(byName.get('run_verb')?.callCount30d).toBe(1);
    expect(byName.get('complete_verb')?.callCount30d).toBe(1);
  });

  it('reports never-invoked tools with count 0 and null lastInvoked', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeJsonl(tempDir, 'logs/2026-05-13.jsonl', [
      { timestamp: '2026-05-13T07:48:00Z', action: 'tool_call', tool: 'write_memory' },
    ]);

    const report = await loadCapabilities(tempDir, now);
    const propose = report.chatTools.find((t) => t.name === 'propose_verb');
    expect(propose).toBeDefined();
    expect(propose?.callCount30d).toBe(0);
    expect(propose?.lastInvoked).toBeNull();
  });

  it('excludes entries older than 30 days from the count but keeps them as lastInvoked', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeJsonl(tempDir, 'logs/2026-04-12.jsonl', [
      // 31 days ago — outside the window.
      { timestamp: '2026-04-12T09:00:00Z', action: 'tool_call', tool: 'write_memory' },
    ]);

    const report = await loadCapabilities(tempDir, now);
    const write = report.chatTools.find((t) => t.name === 'write_memory');
    expect(write?.callCount30d).toBe(0);
    expect(write?.lastInvoked).toBe('2026-04-12T09:00:00Z');
  });

  it('reports implicit-full autonomy for every chat tool', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const report = await loadCapabilities(tempDir, now);
    for (const tool of report.chatTools) {
      expect(tool.autonomyMode).toBe('implicit-full');
    }
  });
});

describe('loadCapabilities — verbs', () => {
  it('aggregates verb invocation counts and outcome distribution', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeFile(tempDir, 'verbs/escalate.md', '# Escalate Verb\n\nRaise structured asks.');
    await writeFile(
      tempDir,
      'verbs/discover.md',
      '# Discovery Verb\n\nFind new prospects.',
    );
    await writeJsonl(tempDir, 'logs/2026-05-13.jsonl', [
      { timestamp: '2026-05-13T07:00:00Z', action: 'verb_started', verb: 'escalate' },
      { timestamp: '2026-05-13T07:30:00Z', action: 'verb_completed', verb: 'escalate', outcome: 'success' },
      { timestamp: '2026-05-13T08:00:00Z', action: 'verb_started', verb: 'escalate' },
      { timestamp: '2026-05-13T08:15:00Z', action: 'verb_completed', verb: 'escalate', outcome: 'failed' },
      { timestamp: '2026-05-13T09:00:00Z', action: 'verb_started', verb: 'escalate' },
      // Bogus outcome — should be ignored, not crash.
      { timestamp: '2026-05-13T09:15:00Z', action: 'verb_completed', verb: 'escalate', outcome: 'mysterious' },
    ]);

    const report = await loadCapabilities(tempDir, now);
    const escalate = report.verbs.find((v) => v.slug === 'escalate');
    expect(escalate).toBeDefined();
    expect(escalate?.invocationCount30d).toBe(3);
    expect(escalate?.outcomes).toEqual({ success: 1, partial: 0, failed: 1, skipped: 0 });
    expect(escalate?.lastInvoked).toBe('2026-05-13T09:00:00Z');

    const discover = report.verbs.find((v) => v.slug === 'discover');
    expect(discover?.invocationCount30d).toBe(0);
    expect(discover?.lastInvoked).toBeNull();
    expect(discover?.outcomes).toEqual({ success: 0, partial: 0, failed: 0, skipped: 0 });
  });
});

describe('loadCapabilities — reference data', () => {
  it('lists lib files, excluding the constitutional set', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeFile(tempDir, 'lib/customers.yaml', 'customers: []');
    await writeFile(tempDir, 'lib/compliance.yaml', 'rules: []');
    await writeFile(tempDir, 'lib/autonomy.yaml', 'surfaces: []');
    await writeFile(tempDir, 'lib/tools.yaml', 'capabilities: {}');
    await writeFile(tempDir, 'lib/research-strategies.yaml', 'strategies: []');
    await writeFile(tempDir, 'lib/team.yaml', 'members: []');

    const report = await loadCapabilities(tempDir, now);
    const filenames = report.refData.map((r) => r.filename);
    expect(filenames).toEqual(['research-strategies.yaml', 'team.yaml']);
    for (const r of report.refData) {
      // No autonomy.yaml on the surface yet, so mode + hint are null.
      expect(r.autonomyMode).toBeNull();
      expect(r.modeHint).toBeNull();
    }
  });

  it('resolves autonomy mode and per-mode hints', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeFile(
      tempDir,
      'lib/autonomy.yaml',
      [
        'surfaces:',
        '  - path: lib/research-strategies.yaml',
        '    mode: append-only',
        '    max_pending: 5',
        '    root_key: strategies',
        '    unique_by: id',
        '  - path: lib/warmup.yaml',
        '    mode: bounded',
        '    bounds:',
        '      sends_per_day: { min: 1, max: 10, step: 1 }',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    root_key: members',
        '    unique_by: id',
        '    soft_fields: [notes]',
        '',
      ].join('\n'),
    );
    await writeFile(tempDir, 'lib/research-strategies.yaml', 'strategies: []');
    await writeFile(tempDir, 'lib/warmup.yaml', 'sends_per_day: 5');
    await writeFile(tempDir, 'lib/team.yaml', 'members: []');

    const report = await loadCapabilities(tempDir, now);
    const byName = new Map(report.refData.map((r) => [r.filename, r]));
    const research = byName.get('research-strategies.yaml');
    expect(research?.autonomyMode).toBe('append-only');
    expect(research?.modeHint).toBe('max 5 pending');
    const warmup = byName.get('warmup.yaml');
    expect(warmup?.autonomyMode).toBe('bounded');
    expect(warmup?.modeHint).toBe('params: sends_per_day [1..10 step 1]');
    const team = byName.get('team.yaml');
    expect(team?.autonomyMode).toBe('inline-enrichment');
    expect(team?.modeHint).toBe('editable fields per entry');
  });

  it('lastEditIso is null when the directory is not a git repo', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    await writeFile(tempDir, 'lib/research-strategies.yaml', 'strategies: []');

    const report = await loadCapabilities(tempDir, now);
    expect(report.refData[0]?.lastEditIso).toBeNull();
  });

  it('reads the most recent role-author commit date for a lib file', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.email', 'host@example.test', false, 'local');
    await git.addConfig('user.name', 'Host User', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');

    await writeFile(tempDir, 'lib/research-strategies.yaml', 'strategies: []\n');
    await git.add('lib/research-strategies.yaml');
    await git.raw([
      'commit',
      '--author=Praxis Role <role@praxis.local>',
      '-m',
      'role(lib): append strategies',
    ]);

    const report = await loadCapabilities(tempDir, now);
    const research = report.refData.find((r) => r.filename === 'research-strategies.yaml');
    expect(research?.lastEditIso).not.toBeNull();
    expect(research?.lastEditIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('loadCapabilities — mcp placeholder', () => {
  it('returns the unconfigured placeholder shape', async () => {
    const now = new Date('2026-05-13T10:00:00Z');
    const report = await loadCapabilities(tempDir, now);
    expect(report.mcps.configured).toBe(false);
    expect(report.mcps.message).toMatch(/MCP support in issue #25/);
  });
});
