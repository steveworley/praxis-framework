import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = dashboard/src/lib  →  walk up to repo root, then into template/bin/log.
const SCRIPT_PATH = path.resolve(here, '..', '..', '..', 'template', 'bin', 'log');

interface RunOptions {
  cwd: string;
  samsHome?: string;
}

function runScript(args: string[], opts: RunOptions): SpawnSyncReturns<string> {
  // Build a deliberately clean env so we never inherit SAMS_HOME from the
  // parent shell. PATH and HOME are kept so python3 + tempfile resolution work.
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
  };
  if (opts.samsHome) env['SAMS_HOME'] = opts.samsHome;
  return spawnSync('python3', [SCRIPT_PATH, ...args], {
    cwd: opts.cwd,
    env,
    encoding: 'utf-8',
  });
}

async function readJsonl(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function todayIsoDate(): string {
  // Local date in YYYY-MM-DD — matches `datetime.now().astimezone().date().isoformat()`.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-bin-log-'));
  await fs.mkdir(path.join(tempDir, 'campaigns', 'test-campaign'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('bin/log', () => {
  it('writes a minimal entry with required fields only', async () => {
    const result = runScript(
      [
        '--campaign=test-campaign',
        '--agent=test-agent',
        '--action=test_action',
        '--echo',
      ],
      { cwd: tempDir },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    const logPath = path.join(tempDir, 'campaigns', 'test-campaign', 'logs', `${todayIsoDate()}.jsonl`);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(1);

    const entry = lines[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry['agent']).toBe('test-agent');
    expect(entry['action']).toBe('test_action');
    expect(entry['campaign_id']).toBe('test-campaign');
    expect(typeof entry['timestamp']).toBe('string');
    // ISO 8601 with timezone offset (e.g. 2026-05-05T10:00:00+10:00 or ...Z).
    expect(entry['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
    expect(entry).not.toHaveProperty('prospect_id');
    expect(entry).not.toHaveProperty('details');
    expect(entry).not.toHaveProperty('subject');

    // stdout (echo) is the JSON line — parses to the same record.
    expect(JSON.parse(result.stdout.trim())).toEqual(entry);
  });

  it('writes all conventional flags plus extras with timestamp first', async () => {
    const result = runScript(
      [
        '--campaign=test-campaign',
        '--agent=draft-emails',
        '--action=email_drafted',
        '--prospect=acme',
        '--details=Drafted opener',
        '--subject=Hello there',
        'channel=notifications-searchai',
        'message_ts=1234.5',
      ],
      { cwd: tempDir },
    );

    expect(result.status).toBe(0);

    const logPath = path.join(tempDir, 'campaigns', 'test-campaign', 'logs', `${todayIsoDate()}.jsonl`);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(1);

    const entry = lines[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry['agent']).toBe('draft-emails');
    expect(entry['action']).toBe('email_drafted');
    expect(entry['prospect_id']).toBe('acme');
    expect(entry['campaign_id']).toBe('test-campaign');
    expect(entry['details']).toBe('Drafted opener');
    expect(entry['subject']).toBe('Hello there');
    expect(entry['channel']).toBe('notifications-searchai');
    expect(entry['message_ts']).toBe('1234.5');

    // Field ordering: timestamp first, conventional fields, then extras.
    const keys = Object.keys(entry);
    expect(keys[0]).toBe('timestamp');
    expect(keys.indexOf('channel')).toBeGreaterThan(keys.indexOf('subject'));
    expect(keys.indexOf('message_ts')).toBeGreaterThan(keys.indexOf('channel'));
  });

  it('warns and ignores an extra that shadows a flag value', async () => {
    const result = runScript(
      [
        '--campaign=test-campaign',
        '--agent=real',
        '--action=test_action',
        'agent=hijack',
        '--echo',
      ],
      { cwd: tempDir },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('shadowed by flag value');

    const logPath = path.join(tempDir, 'campaigns', 'test-campaign', 'logs', `${todayIsoDate()}.jsonl`);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(1);

    const entry = lines[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry['agent']).toBe('real');
    // The shadowed extra must not have leaked into the record under a
    // different key — there's only one `agent` field, owned by the flag.
    const agentEntries = Object.entries(entry).filter(([k]) => k === 'agent');
    expect(agentEntries).toHaveLength(1);
  });

  it('errors when an extra arg is missing the = separator', async () => {
    const result = runScript(
      [
        '--campaign=test-campaign',
        '--agent=test-agent',
        '--action=test_action',
        'bareword',
      ],
      { cwd: tempDir },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('key=value');
  });

  it('errors when the campaign directory does not exist', async () => {
    const result = runScript(
      [
        '--campaign=does-not-exist',
        '--agent=test-agent',
        '--action=test_action',
      ],
      { cwd: tempDir },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Campaign directory does not exist');
  });

  it('errors when run outside any repo and SAMS_HOME is unset', async () => {
    // A fresh temp dir with NO campaigns/ ancestor.
    const orphan = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-bin-log-orphan-'));
    try {
      const result = runScript(
        [
          '--campaign=test-campaign',
          '--agent=test-agent',
          '--action=test_action',
        ],
        { cwd: orphan },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Could not locate');
    } finally {
      await fs.rm(orphan, { recursive: true, force: true });
    }
  });

  it('honours SAMS_HOME when cwd is unrelated', async () => {
    // Run from an unrelated tmp dir, but point SAMS_HOME at our temp repo.
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-bin-log-elsewhere-'));
    try {
      const result = runScript(
        [
          '--campaign=test-campaign',
          '--agent=test-agent',
          '--action=test_action',
        ],
        { cwd: elsewhere, samsHome: tempDir },
      );

      expect(result.status).toBe(0);

      const logPath = path.join(tempDir, 'campaigns', 'test-campaign', 'logs', `${todayIsoDate()}.jsonl`);
      const lines = await readJsonl(logPath);
      expect(lines).toHaveLength(1);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('appends successive entries to the same log file', async () => {
    const args = [
      '--campaign=test-campaign',
      '--agent=test-agent',
      '--action=test_action',
    ];
    const first = runScript(args, { cwd: tempDir });
    const second = runScript([...args, '--prospect=acme'], { cwd: tempDir });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const logPath = path.join(tempDir, 'campaigns', 'test-campaign', 'logs', `${todayIsoDate()}.jsonl`);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toHaveProperty('prospect_id');
    expect(lines[1]?.['prospect_id']).toBe('acme');
  });
});
