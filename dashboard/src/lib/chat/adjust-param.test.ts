import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeAdjustParam, _internals } from './adjust-param.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-adjust-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

async function writeWarmupFile(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'warmup.yaml'), text, 'utf-8');
}

const WARMUP_AUTONOMY = [
  'surfaces:',
  '  - path: lib/warmup.yaml',
  '    mode: bounded',
  '    bounds:',
  '      sends_per_day: { min: 10, max: 100, step: 5 }',
  '      weeks_to_full_send_rate: { min: 4, max: 12 }',
  '      new_thread_ratio: { min: 0.1, max: 0.9 }',
  '    why: |',
  '      Warmup throttle parameters; I tune within ranges based on',
  '      observed deliverability.',
].join('\n');

const WARMUP_FILE = [
  '# Warmup throttle parameters',
  '# Operator-authored ceilings; the role adjusts within bounds.',
  'sends_per_day: 25',
  'weeks_to_full_send_rate: 6',
  'new_thread_ratio: 0.3',
  '',
].join('\n');

describe('executeAdjustParam — happy path', () => {
  beforeEach(async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
  });

  it('updates an in-range step-aligned value', async () => {
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('lib/warmup.yaml');
    expect(r.data['key']).toBe('sends_per_day');
    expect(r.data['new_value']).toBe(30);
    expect(r.data['previous_value']).toBe(25);

    const text = await fs.readFile(path.join(tempDir, 'lib/warmup.yaml'), 'utf-8');
    expect(text).toContain('sends_per_day: 30');
    expect(text).not.toContain('sends_per_day: 25');
    // Other lines untouched.
    expect(text).toContain('weeks_to_full_send_rate: 6');
    expect(text).toContain('new_thread_ratio: 0.3');
    expect(text).toContain('# Warmup throttle parameters');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('accepts boundary value == min', async () => {
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 10,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts boundary value == max', async () => {
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 100,
    });
    expect(r.ok).toBe(true);
  });

  it('updates a bound without a step constraint at any integer in range', async () => {
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'weeks_to_full_send_rate',
      value: 7,
    });
    expect(r.ok).toBe(true);
    const text = await fs.readFile(path.join(tempDir, 'lib/warmup.yaml'), 'utf-8');
    expect(text).toContain('weeks_to_full_send_rate: 7');
  });

  it('updates a decimal value within decimal bounds', async () => {
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'new_thread_ratio',
      value: 0.45,
    });
    expect(r.ok).toBe(true);
    const text = await fs.readFile(path.join(tempDir, 'lib/warmup.yaml'), 'utf-8');
    expect(text).toContain('new_thread_ratio: 0.45');
  });

  it('handles step-aligned decimal values with floating-point tolerance', async () => {
    // step 0.05, min 0.1 — value 0.3 is offset 0.2 = 4 * 0.05 (FP ok).
    const autonomy = [
      'surfaces:',
      '  - path: lib/warmup.yaml',
      '    mode: bounded',
      '    bounds:',
      '      ratio: { min: 0.1, max: 0.9, step: 0.05 }',
    ].join('\n');
    await writeAutonomy(autonomy);
    await writeWarmupFile('ratio: 0.1\n');

    const r1 = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'ratio',
      value: 0.3,
    });
    expect(r1.ok).toBe(true);

    const r2 = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'ratio',
      value: 0.55,
    });
    expect(r2.ok).toBe(true);
  });

  it('appends a new key when the file does not yet contain it', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    // File is missing `sends_per_day` entirely.
    await writeWarmupFile('weeks_to_full_send_rate: 6\nnew_thread_ratio: 0.3\n');

    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 25,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No previous value reported when the key didn't exist.
    expect(r.data['previous_value']).toBeUndefined();
    expect(r.data['new_value']).toBe(25);

    const text = await fs.readFile(path.join(tempDir, 'lib/warmup.yaml'), 'utf-8');
    expect(text).toContain('sends_per_day: 25');
    expect(text).toContain('weeks_to_full_send_rate: 6');
  });

  it('returns commit info when the role home is a git repo', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);

    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Operator', false, 'local');
    await git.addConfig('user.email', 'op@example.test', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    await git.add(['persona.md', 'lib/autonomy.yaml', 'lib/warmup.yaml']);
    await git.raw([
      '-c', 'user.name=Operator',
      '-c', 'user.email=op@example.test',
      'commit', '--author=Operator <op@example.test>', '--no-gpg-sign',
      '-m', 'init',
    ]);

    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect(r.data['commit_short_sha']).toMatch(/^[0-9a-f]{7}$/);

    const subject = (
      await git.raw(['log', '-n', '1', '--pretty=format:%s'])
    ).trim();
    expect(subject).toBe('role(lib): adjust warmup:sends_per_day');
    const authorLine = (
      await git.raw(['log', '-n', '1', '--pretty=format:%an <%ae>'])
    ).trim();
    expect(authorLine).toBe('Praxis Role <role@praxis.local>');
  });
});

describe('executeAdjustParam — refusal cases', () => {
  it('refuses when path is not in autonomy.yaml', async () => {
    await writeAutonomy('surfaces:\n  - path: memory/\n    mode: full\n');
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not opened in lib\/autonomy\.yaml/);
  });

  it("refuses when mode isn't bounded", async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/warmup.yaml', '    mode: full'].join('\n'),
    );
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not 'bounded'/);
  });

  it('refuses when bounds is missing on the autonomy.yaml entry', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/warmup.yaml',
        '    mode: bounded',
        // No bounds declared.
      ].join('\n'),
    );
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't declare 'bounds'/);
  });

  it('refuses when the key is not in the declared bounds', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'retry_count',
      value: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/key 'retry_count' is not in lib\/warmup\.yaml's bounds/);
      expect(r.error).toMatch(/Declared bounded keys:.*sends_per_day/);
    }
  });

  it('refuses below-min values', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/value 5 is below min \(10\)/);
  });

  it('refuses above-max values', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 200,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/value 200 is above max \(100\)/);
  });

  it('refuses values that are not step-aligned', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 23,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/value 23.*isn't a multiple of step 5/);
    }
  });

  it('refuses when path is not a YAML extension', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.json',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a YAML file/);
  });

  it('refuses when the file is missing', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot read lib\/warmup\.yaml/);
  });

  it('refuses path-traversal attempts', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    const r = await executeAdjustParam(tempDir, {
      path: '../etc/passwd.yaml',
      key: 'sends_per_day',
      value: 30,
    });
    expect(r.ok).toBe(false);
  });

  it('refuses invalid input shape', async () => {
    const r = await executeAdjustParam(tempDir, { path: 'lib/x.yaml' });
    expect(r.ok).toBe(false);
  });

  it('refuses non-finite values', async () => {
    // Schema parses through zod (which accepts Infinity as a number), but
    // we double-check at the executor for finite values.
    await writeAutonomy(WARMUP_AUTONOMY);
    await writeWarmupFile(WARMUP_FILE);
    const r = await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: Number.POSITIVE_INFINITY,
    });
    expect(r.ok).toBe(false);
  });
});

describe('executeAdjustParam — formatting preservation', () => {
  it('preserves comments and other lines verbatim', async () => {
    await writeAutonomy(WARMUP_AUTONOMY);
    const before = [
      '# Warmup throttle parameters',
      '# Operator-authored ceilings; the role adjusts within bounds.',
      '',
      '# section: send throughput',
      'sends_per_day: 25',
      '',
      '# section: ramp duration',
      'weeks_to_full_send_rate: 6',
      'new_thread_ratio: 0.3',
      '',
    ].join('\n');
    await writeWarmupFile(before);

    await executeAdjustParam(tempDir, {
      path: 'lib/warmup.yaml',
      key: 'sends_per_day',
      value: 35,
    });
    const after = await fs.readFile(path.join(tempDir, 'lib/warmup.yaml'), 'utf-8');
    expect(after).toContain('# Warmup throttle parameters');
    expect(after).toContain('# section: send throughput');
    expect(after).toContain('# section: ramp duration');
    expect(after).toContain('sends_per_day: 35');
    expect(after).not.toContain('sends_per_day: 25');
    expect(after).toContain('weeks_to_full_send_rate: 6');
    expect(after).toContain('new_thread_ratio: 0.3');
  });
});

describe('applyValue internals', () => {
  it('replaces an existing top-level key value, preserves surrounding text', () => {
    const text = '# header\nsends_per_day: 10\nweeks: 4\n';
    const r = _internals.applyValue(text, 'sends_per_day', 25);
    expect(r.previousValue).toBe(10);
    expect(r.text).toBe('# header\nsends_per_day: 25\nweeks: 4\n');
  });

  it('appends a new top-level key when the file does not already have it', () => {
    const text = 'weeks: 4\n';
    const r = _internals.applyValue(text, 'sends_per_day', 25);
    expect(r.previousValue).toBeUndefined();
    expect(r.text).toBe('weeks: 4\nsends_per_day: 25\n');
  });

  it('adds a trailing newline when appending to a file without one', () => {
    const text = 'weeks: 4';
    const r = _internals.applyValue(text, 'sends_per_day', 25);
    expect(r.text).toBe('weeks: 4\nsends_per_day: 25\n');
  });

  it('does not match indented keys (only top-level)', () => {
    const text = 'parent:\n  sends_per_day: 10\n';
    const r = _internals.applyValue(text, 'sends_per_day', 25);
    expect(r.previousValue).toBeUndefined();
    // The new line is appended at the end; the indented one is untouched.
    expect(r.text).toContain('  sends_per_day: 10');
    expect(r.text).toContain('sends_per_day: 25');
  });
});

describe('checkRange internals', () => {
  it('rejects step-misaligned decimals just outside tolerance', () => {
    const err = _internals.checkRange(
      0.3 + 1e-3,
      { min: 0.1, max: 0.9, step: 0.05 },
      'lib/warmup.yaml',
      'ratio',
    );
    expect(err).toMatch(/multiple of step/);
  });

  it('accepts step-aligned values at the tolerance boundary', () => {
    // 0.3 = 0.1 + 4 * 0.05 — the canonical floating-point hazard.
    expect(
      _internals.checkRange(
        0.3,
        { min: 0.1, max: 0.9, step: 0.05 },
        'lib/warmup.yaml',
        'ratio',
      ),
    ).toBeNull();
  });

  it('passes the min boundary as step-aligned', () => {
    expect(
      _internals.checkRange(
        10,
        { min: 10, max: 100, step: 5 },
        'lib/warmup.yaml',
        'sends_per_day',
      ),
    ).toBeNull();
  });
});
