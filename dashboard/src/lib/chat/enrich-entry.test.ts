import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeEnrichEntry, _internals } from './enrich-entry.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-enrich-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

async function writeTeamFile(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'team.yaml'), text, 'utf-8');
}

const TEAM_AUTONOMY = [
  'surfaces:',
  '  - path: lib/team.yaml',
  '    mode: inline-enrichment',
  '    root_key: members',
  '    unique_by: id',
  '    soft_fields:',
  '      - notes',
  '      - last_observed_at',
  '    why: |',
  '      Structured team data is operator-owned (name, role, email); I',
  '      keep the notes column current with what I observe in conversations.',
].join('\n');

const TEAM_FILE = [
  '# Team — quant outreach',
  'members:',
  '  - id: steve',
  '    name: Steve Worley',
  '    role: Operator',
  '    email: sj.worley88@gmail.com',
  '    notes: starts the day in standup; prefers Slack DM for urgent.',
  '  - id: mary',
  '    name: Mary Chen',
  '    role: Account exec',
  '    email: mary@quantcdn.io',
  '',
].join('\n');

describe('executeEnrichEntry — happy path', () => {
  beforeEach(async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
  });

  it('updates an existing soft field in place', async () => {
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: {
        notes: 'morning person; pings via Slack for anything urgent.',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('lib/team.yaml');
    expect(r.data['entry_id']).toBe('steve');
    expect(r.data['fields_updated']).toEqual(['notes']);

    const text = await fs.readFile(path.join(tempDir, 'lib/team.yaml'), 'utf-8');
    expect(text).toContain('# Team — quant outreach');
    expect(text).toContain('id: steve');
    expect(text).toContain('name: Steve Worley');
    expect(text).toContain('email: sj.worley88@gmail.com');
    // The note string is YAML-safe so it lands bare (no quoting needed).
    expect(text).toContain(
      'notes: morning person; pings via Slack for anything urgent.',
    );
    // The other entry is untouched.
    expect(text).toContain('id: mary');
    expect(text).toContain('email: mary@quantcdn.io');
    // The original notes line is gone.
    expect(text).not.toContain('starts the day in standup');
  });

  it('updates multiple soft fields in one call', async () => {
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: {
        notes: 'updated note',
        last_observed_at: '2026-05-08',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['fields_updated']).toEqual(['notes', 'last_observed_at']);

    const text = await fs.readFile(path.join(tempDir, 'lib/team.yaml'), 'utf-8');
    expect(text).toContain('notes: updated note');
    expect(text).toContain('last_observed_at: 2026-05-08');
  });

  it('appends a soft field that does not yet exist on the entry', async () => {
    // mary has no `notes` and no `last_observed_at` yet — both should append.
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'mary',
      soft_fields: {
        notes: 'first call went well; follow up next week.',
        last_observed_at: '2026-05-08',
      },
    });
    expect(r.ok).toBe(true);

    const text = await fs.readFile(path.join(tempDir, 'lib/team.yaml'), 'utf-8');
    // Mary entry now has notes + last_observed_at after email line.
    const maryBlock = text.slice(text.indexOf('id: mary'));
    expect(maryBlock).toContain('email: mary@quantcdn.io');
    expect(maryBlock).toContain(
      'notes: first call went well; follow up next week.',
    );
    expect(maryBlock).toContain('last_observed_at: 2026-05-08');
    // Steve's original notes line stays exactly as it was.
    expect(text).toContain(
      'notes: starts the day in standup; prefers Slack DM for urgent.',
    );
  });

  it('returns commit info when the role home is a git repo', async () => {
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Operator', false, 'local');
    await git.addConfig('user.email', 'op@example.test', false, 'local');
    await git.addConfig('commit.gpgsign', 'false', false, 'local');
    await git.add(['persona.md', 'lib/autonomy.yaml', 'lib/team.yaml']);
    await git.raw([
      '-c', 'user.name=Operator',
      '-c', 'user.email=op@example.test',
      'commit', '--author=Operator <op@example.test>', '--no-gpg-sign',
      '-m', 'init',
    ]);

    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'new note' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data['commit_sha']).toBe('string');
    expect(r.data['commit_short_sha']).toMatch(/^[0-9a-f]{7}$/);

    const subject = (
      await git.raw(['log', '-n', '1', '--pretty=format:%s'])
    ).trim();
    expect(subject).toBe('role(lib): enrich team');
    const authorLine = (
      await git.raw(['log', '-n', '1', '--pretty=format:%an <%ae>'])
    ).trim();
    expect(authorLine).toBe('Praxis Role <role@praxis.local>');
  });
});

describe('executeEnrichEntry — refusal cases', () => {
  it('refuses when path is not in autonomy.yaml', async () => {
    await writeAutonomy('surfaces:\n  - path: memory/\n    mode: full\n');
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not opened in lib\/autonomy\.yaml/);
  });

  it("refuses when mode isn't inline-enrichment", async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/team.yaml', '    mode: full'].join('\n'),
    );
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not 'inline-enrichment'/);
  });

  it('refuses when soft_fields is missing on the autonomy.yaml entry', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    root_key: members',
        '    unique_by: id',
        // No soft_fields declared.
      ].join('\n'),
    );
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't declare 'soft_fields'/);
  });

  it('refuses when unique_by is missing on the autonomy.yaml entry', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    root_key: members',
        '    soft_fields:',
        '      - notes',
      ].join('\n'),
    );
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't declare 'unique_by'/);
  });

  it('refuses when root_key is missing on the autonomy.yaml entry', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    unique_by: id',
        '    soft_fields:',
        '      - notes',
      ].join('\n'),
    );
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't declare 'root_key'/);
  });

  it('refuses when no entry matches entry_id', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'ghost',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no entry with id='ghost'/);
      expect(r.error).toMatch(/can't create entries/);
      expect(r.error).toMatch(/proposed_skill/);
    }
  });

  it('refuses when a supplied field is not in the soft_fields whitelist', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { email: 'rewritten@example.com' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/field 'email' not in lib\/team\.yaml's soft_fields/);
      expect(r.error).toMatch(/Declared soft fields: notes, last_observed_at/);
    }
  });

  it('refuses with all offending fields named when several are off-limits', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { email: 'x', role: 'y' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/fields 'email', 'role'/);
    }
  });

  it('refuses when path is not a YAML extension', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.json',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a YAML file/);
  });

  it('refuses when the file is missing', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot read lib\/team\.yaml/);
  });

  it('refuses when the file does not declare the root_key', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile('# wrong shape\nsomething_else:\n  - foo\n');
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not declare a top-level 'members:'/);
  });

  it('refuses path-traversal attempts', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    const r = await executeEnrichEntry(tempDir, {
      path: '../etc/passwd.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'x' },
    });
    expect(r.ok).toBe(false);
  });

  it('refuses invalid input shape', async () => {
    const r = await executeEnrichEntry(tempDir, { path: 'lib/x.yaml' });
    expect(r.ok).toBe(false);
  });

  it('refuses an empty soft_fields object', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
    const r = await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe('executeEnrichEntry — formatting preservation', () => {
  it('preserves the header comment and existing whitespace', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    await writeTeamFile(TEAM_FILE);
    await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'updated' },
    });
    const text = await fs.readFile(path.join(tempDir, 'lib/team.yaml'), 'utf-8');
    // Header comment stays at the top.
    expect(text.split('\n')[0]).toBe('# Team — quant outreach');
    // Members heading is right after.
    expect(text.split('\n')[1]).toBe('members:');
    // File ends with a trailing newline (the original had one).
    expect(text.endsWith('\n')).toBe(true);
  });

  it('preserves inline comments inside an entry', async () => {
    await writeAutonomy(TEAM_AUTONOMY);
    const fileWithComment = [
      'members:',
      '  - id: steve',
      '    name: Steve Worley',
      '    # operator since v0',
      '    role: Operator',
      '    notes: original',
      '',
    ].join('\n');
    await writeTeamFile(fileWithComment);
    await executeEnrichEntry(tempDir, {
      path: 'lib/team.yaml',
      entry_id: 'steve',
      soft_fields: { notes: 'changed' },
    });
    const text = await fs.readFile(path.join(tempDir, 'lib/team.yaml'), 'utf-8');
    expect(text).toContain('# operator since v0');
    expect(text).toContain('notes: changed');
    expect(text).not.toContain('notes: original');
  });
});

describe('locateList internals', () => {
  it('returns existing entries with their inline fields and line ranges', () => {
    const text = [
      'members:',
      '  - id: a',
      '    notes: first',
      '  - id: b',
      '    notes: second',
      '',
    ].join('\n');
    const info = _internals.locateList(text, 'members');
    expect(info.entries).toHaveLength(2);
    expect(info.entries[0]?.fields['id']).toBe('a');
    expect(info.entries[0]?.fields['notes']).toBe('first');
    expect(info.entries[0]?.fieldLines['id']).toBe(1);
    expect(info.entries[0]?.fieldLines['notes']).toBe(2);
    expect(info.entries[1]?.fields['id']).toBe('b');
    expect(info.entries[1]?.fieldLines['id']).toBe(3);
  });

  it('throws when root_key is absent', () => {
    expect(() => _internals.locateList('other: 1\n', 'members')).toThrow(
      /does not declare/,
    );
  });
});

describe('emitScalar + yamlString', () => {
  it('quotes strings that need it and passes safe ones through bare', () => {
    expect(_internals.yamlString('foo: bar')).toBe("'foo: bar'");
    expect(_internals.yamlString('starts the day in standup')).toBe(
      'starts the day in standup',
    );
    expect(_internals.yamlString('true')).toBe("'true'");
  });

  it('emits booleans and numbers and null bare', () => {
    expect(_internals.emitScalar(true)).toBe('true');
    expect(_internals.emitScalar(42)).toBe('42');
    expect(_internals.emitScalar(null)).toBe('null');
  });
});
