import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeAppendEntry, _internals } from './append-entry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-append-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

async function writeStrategiesFile(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, 'lib', 'research-strategies.yaml'),
    text,
    'utf-8',
  );
}

const STRATEGIES_AUTONOMY = [
  'surfaces:',
  '  - path: lib/research-strategies.yaml',
  '    mode: append-only',
  '    max_pending: 3',
  '    root_key: strategies',
  '    unique_by: id',
  '    why: |',
  '      Org-type page conventions I notice while running find-contacts.',
].join('\n');

const STRATEGIES_FILE = [
  '# Org-type page conventions',
  'strategies:',
  '  - id: au-tafes-leadership',
  '    pattern: "AU TAFEs: leadership at /about/leadership"',
  '    observed: 2026-04-12',
  '    confidence: high',
  '    reviewed: true',
  '  - id: multi-brand-au-institutes',
  '    pattern: "Multi-brand AU institutes: corporate page on parent subdomain"',
  '    observed: 2026-04-15',
  '    confidence: medium',
  '    reviewed: false',
  '',
].join('\n');

describe('executeAppendEntry — happy path', () => {
  beforeEach(async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    await writeStrategiesFile(STRATEGIES_FILE);
  });

  it('appends a valid entry to the end of the list', async () => {
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: {
        id: 'us-community-colleges',
        pattern: 'US community colleges keep leadership on /about/administration',
        observed: '2026-05-08',
        confidence: 'medium',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('lib/research-strategies.yaml');
    expect(r.data['count']).toBe(3);
    expect(r.data['root_key']).toBe('strategies');
    expect(r.data['max_pending']).toBe(3);

    const text = await fs.readFile(
      path.join(tempDir, 'lib/research-strategies.yaml'),
      'utf-8',
    );
    // Preserves the comment + existing entries.
    expect(text).toContain('# Org-type page conventions');
    expect(text).toContain('id: au-tafes-leadership');
    expect(text).toContain('id: multi-brand-au-institutes');
    // Appended entry present with reviewed: false injected.
    expect(text).toContain('id: us-community-colleges');
    expect(text).toMatch(/id: us-community-colleges[\s\S]*reviewed: false/);
  });

  it('preserves an explicit `reviewed: true` if the model sets it', async () => {
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: {
        id: 'pre-reviewed',
        pattern: 'something obvious',
        reviewed: true,
      },
    });
    expect(r.ok).toBe(true);
    const text = await fs.readFile(
      path.join(tempDir, 'lib/research-strategies.yaml'),
      'utf-8',
    );
    // Only one `reviewed: true` line should be present in the appended block
    // for the new id; the existing au-tafes-leadership also has reviewed: true.
    const appendedBlock = text.slice(text.indexOf('id: pre-reviewed'));
    expect(appendedBlock).toMatch(/reviewed: true/);
    expect(appendedBlock).not.toMatch(/reviewed: false/);
  });

  it('returns commit info when the role home is a git repo', async () => {
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Operator', false, 'local');
    await git.addConfig('user.email', 'op@example.test', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    await git.add(['persona.md', 'lib/autonomy.yaml', 'lib/research-strategies.yaml']);
    await git.raw([
      '-c', 'user.name=Operator',
      '-c', 'user.email=op@example.test',
      'commit', '--author=Operator <op@example.test>', '--no-gpg-sign',
      '-m', 'init',
    ]);

    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'fresh', pattern: 'p' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect(r.data['commit_short_sha']).toMatch(/^[0-9a-f]{7}$/);

    const subject = (
      await git.raw(['log', '-n', '1', '--pretty=format:%s'])
    ).trim();
    expect(subject).toBe('role(lib): append research-strategies');
    const authorLine = (
      await git.raw(['log', '-n', '1', '--pretty=format:%an <%ae>'])
    ).trim();
    expect(authorLine).toBe('Praxis Role <role@praxis.local>');
  });
});

describe('executeAppendEntry — refusal cases', () => {
  it('refuses when path is not in autonomy.yaml', async () => {
    await writeAutonomy('surfaces:\n  - path: memory/\n    mode: full\n');
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not opened in lib\/autonomy\.yaml/);
  });

  it("refuses when mode isn't append-only", async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/research-strategies.yaml', '    mode: full'].join('\n'),
    );
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not 'append-only'/);
  });

  it('refuses when the gate refuses (gated mode)', async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/research-strategies.yaml', '    mode: gated'].join('\n'),
    );
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/gated/);
  });

  it('refuses when max_pending is reached', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    // 3 entries, all reviewed: false → at the ceiling of 3.
    const fileText = [
      'strategies:',
      '  - id: a',
      '    reviewed: false',
      '  - id: b',
      '    reviewed: false',
      '  - id: c',
      '    reviewed: false',
      '',
    ].join('\n');
    await writeStrategiesFile(fileText);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'd' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/refused:/);
      expect(r.error).toMatch(/3 pending entries/);
      expect(r.error).toMatch(/max 3/);
      expect(r.error).toMatch(/compaction escalation/);
    }
  });

  it('refuses when an entry with the same unique_by value already exists', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'au-tafes-leadership', pattern: 'duplicate attempt' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/already exists/);
      expect(r.error).toMatch(/improvement.*escalation/);
    }
  });

  it('refuses when the entry omits the unique_by field', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { pattern: 'no id here' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing the required 'id' field/);
  });

  it('refuses when the file is missing', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot read lib\/research-strategies\.yaml/);
  });

  it('refuses when the file does not declare the root_key', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    await writeStrategiesFile('# wrong shape\nsomething_else:\n  - foo\n');
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not declare a top-level 'strategies:'/);
  });

  it('refuses when autonomy.yaml omits root_key on an append-only surface', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/research-strategies.yaml',
        '    mode: append-only',
        '    max_pending: 5',
        '    unique_by: id',
        // No root_key declared.
      ].join('\n'),
    );
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't declare 'root_key'/);
  });

  it('refuses when path is not a YAML extension', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.json',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a YAML file/);
  });

  it('refuses path-traversal attempts', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    const r = await executeAppendEntry(tempDir, {
      path: '../etc/passwd.yaml',
      entry: { id: 'x' },
    });
    expect(r.ok).toBe(false);
  });

  it('refuses invalid input shape', async () => {
    const r = await executeAppendEntry(tempDir, { path: 'lib/x.yaml' });
    expect(r.ok).toBe(false);
  });

  it('refuses an empty entry object', async () => {
    await writeAutonomy(STRATEGIES_AUTONOMY);
    await writeStrategiesFile(STRATEGIES_FILE);
    const r = await executeAppendEntry(tempDir, {
      path: 'lib/research-strategies.yaml',
      entry: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe('locateList internals', () => {
  it('returns existing entries with their inline fields', () => {
    const text = [
      'strategies:',
      '  - id: a',
      '    confidence: high',
      '    reviewed: true',
      '  - id: b',
      '    reviewed: false',
      '',
    ].join('\n');
    const info = _internals.locateList(text, 'strategies');
    expect(info.entries).toHaveLength(2);
    expect(info.entries[0]?.fields['id']).toBe('a');
    expect(info.entries[0]?.fields['confidence']).toBe('high');
    expect(info.entries[0]?.fields['reviewed']).toBe('true');
    expect(info.entries[1]?.fields['reviewed']).toBe('false');
  });

  it('handles an empty list (root_key declared, no items)', () => {
    const text = ['strategies:', '', '# nothing yet'].join('\n');
    const info = _internals.locateList(text, 'strategies');
    expect(info.entries).toHaveLength(0);
  });

  it('throws when root_key is absent', () => {
    expect(() => _internals.locateList('other: 1\n', 'strategies')).toThrow(
      /does not declare/,
    );
  });
});

describe('serializeEntry + yamlString', () => {
  it('emits an entry with consistent indentation', () => {
    const out = _internals.serializeEntry(
      { id: 'x', pattern: 'simple', reviewed: false },
      4,
      2,
    );
    expect(out).toBe('  - id: x\n    pattern: simple\n    reviewed: false\n');
  });

  it('quotes strings that contain a colon', () => {
    expect(_internals.yamlString('AU TAFEs: leadership')).toBe(
      "'AU TAFEs: leadership'",
    );
  });

  it('quotes ambiguous bare scalars like "true" and "off"', () => {
    expect(_internals.yamlString('true')).toBe("'true'");
    expect(_internals.yamlString('off')).toBe("'off'");
  });

  it('leaves safe identifiers unquoted', () => {
    expect(_internals.yamlString('au-tafes-leadership')).toBe('au-tafes-leadership');
  });

  it('emits booleans and numbers without quotes', () => {
    expect(_internals.emitScalar(true, 4)).toBe('true');
    expect(_internals.emitScalar(42, 4)).toBe('42');
    expect(_internals.emitScalar(null, 4)).toBe('null');
  });
});
