import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LogError, runLog } from './log.js';

interface ParsedRecord {
  [key: string]: string;
}

async function readJsonl(filePath: string): Promise<ParsedRecord[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ParsedRecord);
}

function localDateIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

describe('runLog', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-log-'));
    // Plant the role-root marker so resolveRoleRoot finds tmp.
    await fs.writeFile(path.join(tmp, 'persona.md'), '# placeholder\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('walks up from a nested cwd to find persona.md', async () => {
    const nested = path.join(tmp, 'verbs', 'deeper');
    await fs.mkdir(nested, { recursive: true });

    const { logPath } = await runLog(
      { agent: 'test', action: 'noop' },
      [],
      nested,
    );

    expect(logPath.startsWith(tmp)).toBe(true);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['action']).toBe('noop');
  });

  it('writes campaign-scoped logs under campaigns/{id}/logs/', async () => {
    await fs.mkdir(path.join(tmp, 'campaigns', 'q1'), { recursive: true });

    const now = new Date();
    const { logPath } = await runLog(
      { agent: 'draft', action: 'email_drafted', campaign: 'q1' },
      [],
      tmp,
      now,
    );

    const expected = path.join(tmp, 'campaigns', 'q1', 'logs', `${localDateIso(now)}.jsonl`);
    expect(logPath).toBe(expected);
    const lines = await readJsonl(logPath);
    expect(lines[0]?.['campaign_id']).toBe('q1');
  });

  it('writes unscoped logs under logs/ when no campaign is supplied', async () => {
    const now = new Date();
    const { logPath } = await runLog({ agent: 'test', action: 'noop' }, [], tmp, now);

    const expected = path.join(tmp, 'logs', `${localDateIso(now)}.jsonl`);
    expect(logPath).toBe(expected);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('campaign_id');
  });

  it('lands key=value extras as fields in the JSON object', async () => {
    const { logPath } = await runLog(
      { agent: 'monitor', action: 'channel_intake' },
      ['channel=notifications', 'message_ts=1234.5'],
      tmp,
    );

    const lines = await readJsonl(logPath);
    expect(lines[0]?.['channel']).toBe('notifications');
    expect(lines[0]?.['message_ts']).toBe('1234.5');
  });

  it('orders timestamp first, then conventional fields, then extras', async () => {
    const { logPath } = await runLog(
      {
        agent: 'draft',
        action: 'email_drafted',
        prospect: 'acme',
        subject: 'Hello',
      },
      ['channel=alpha', 'message_ts=99'],
      tmp,
    );

    const lines = await readJsonl(logPath);
    const entry = lines[0];
    expect(entry).toBeDefined();
    if (!entry) return;

    const keys = Object.keys(entry);
    expect(keys[0]).toBe('timestamp');
    expect(keys.indexOf('agent')).toBeGreaterThan(keys.indexOf('timestamp'));
    expect(keys.indexOf('channel')).toBeGreaterThan(keys.indexOf('subject'));
    expect(keys.indexOf('message_ts')).toBeGreaterThan(keys.indexOf('channel'));
  });

  it('appends successive entries to the same daily file', async () => {
    await runLog({ agent: 'test', action: 'first' }, [], tmp);
    await runLog({ agent: 'test', action: 'second' }, [], tmp);

    const logPath = path.join(tmp, 'logs', `${localDateIso(new Date())}.jsonl`);
    const lines = await readJsonl(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.['action']).toBe('first');
    expect(lines[1]?.['action']).toBe('second');
  });

  it('creates parent directories on first write', async () => {
    // `logs/` doesn't exist yet — runLog must create it.
    const { logPath } = await runLog({ agent: 'test', action: 'noop' }, [], tmp);

    const stat = await fs.stat(path.dirname(logPath));
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects when --action is missing', async () => {
    await expect(runLog({ agent: 'test' }, [], tmp)).rejects.toBeInstanceOf(LogError);
  });

  it('rejects when no role root is found by walking up', async () => {
    // An orphan tmp dir with no persona.md ancestor.
    const orphan = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-log-orphan-'));
    try {
      await expect(
        runLog({ agent: 'test', action: 'noop' }, [], orphan),
      ).rejects.toBeInstanceOf(LogError);
    } finally {
      await fs.rm(orphan, { recursive: true, force: true });
    }
  });

  it('rejects when --campaign points at a non-existent campaign directory', async () => {
    await expect(
      runLog(
        { agent: 'test', action: 'noop', campaign: 'does-not-exist' },
        [],
        tmp,
      ),
    ).rejects.toBeInstanceOf(LogError);
  });

  it('rejects bare extras without a = separator', async () => {
    await expect(
      runLog({ agent: 'test', action: 'noop' }, ['bareword'], tmp),
    ).rejects.toBeInstanceOf(LogError);
  });

  it('rejects extras with an empty key', async () => {
    await expect(
      runLog({ agent: 'test', action: 'noop' }, ['=value'], tmp),
    ).rejects.toBeInstanceOf(LogError);
  });

  it('drops extras that would shadow a flag-owned field', async () => {
    // No throw — just a stderr warning — and the flag value wins.
    const { logPath } = await runLog(
      { agent: 'real', action: 'noop' },
      ['agent=hijack'],
      tmp,
    );
    const lines = await readJsonl(logPath);
    expect(lines[0]?.['agent']).toBe('real');
  });

  it('produces an ISO 8601 timestamp with timezone offset', async () => {
    const { logPath } = await runLog({ agent: 'test', action: 'noop' }, [], tmp);
    const lines = await readJsonl(logPath);
    expect(lines[0]?.['timestamp']).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/,
    );
  });
});
