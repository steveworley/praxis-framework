import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMcpAllowed, isMcpToolAllowed, isWriteAllowed } from './autonomy-gate.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-gate-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

describe('isWriteAllowed — path safety', () => {
  it('refuses absolute paths', async () => {
    const d = await isWriteAllowed(tempDir, '/etc/passwd');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/unsafe path/);
  });

  it('refuses traversal segments', async () => {
    const d = await isWriteAllowed(tempDir, 'memory/../../etc/passwd');
    expect(d.allowed).toBe(false);
  });

  it('refuses empty paths', async () => {
    const d = await isWriteAllowed(tempDir, '');
    expect(d.allowed).toBe(false);
  });

  it('refuses null byte injection', async () => {
    const d = await isWriteAllowed(tempDir, 'memory/people/x\0.md');
    expect(d.allowed).toBe(false);
  });
});

describe('isWriteAllowed — constitutional surfaces', () => {
  it('refuses persona.md regardless of autonomy.yaml', async () => {
    await writeAutonomy(['surfaces:', '  - path: persona.md', '    mode: full'].join('\n'));
    const d = await isWriteAllowed(tempDir, 'persona.md');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/constitutional/);
  });

  it('refuses verbs/<name>.md (top-level verb files)', async () => {
    const d = await isWriteAllowed(tempDir, 'verbs/escalate.md');
    expect(d.allowed).toBe(false);
  });

  it('refuses lib/customers.yaml', async () => {
    const d = await isWriteAllowed(tempDir, 'lib/customers.yaml');
    expect(d.allowed).toBe(false);
  });

  it('refuses CLAUDE.md', async () => {
    const d = await isWriteAllowed(tempDir, 'CLAUDE.md');
    expect(d.allowed).toBe(false);
  });

  it('refuses lib/autonomy.yaml (the autonomy file itself)', async () => {
    const d = await isWriteAllowed(tempDir, 'lib/autonomy.yaml');
    expect(d.allowed).toBe(false);
  });

  it('refuses lib/business-context.yaml even when opened as a surface', async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/business-context.yaml', '    mode: full'].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/business-context.yaml');
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/constitutional/);
  });
});

describe('isWriteAllowed — implicit autonomous surfaces', () => {
  it('allows memory/ even when autonomy.yaml is missing', async () => {
    const d = await isWriteAllowed(tempDir, 'memory/people/mary.md');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.mode).toBe('full');
  });

  it('allows escalations/', async () => {
    const d = await isWriteAllowed(tempDir, 'escalations/2026-05-12-foo.md');
    expect(d.allowed).toBe(true);
  });

  it('allows verbs/proposed/ but not verbs/', async () => {
    const proposed = await isWriteAllowed(tempDir, 'verbs/proposed/foo.md');
    expect(proposed.allowed).toBe(true);
    const live = await isWriteAllowed(tempDir, 'verbs/foo.md');
    expect(live.allowed).toBe(false);
  });

  it('allows logs/<date>.jsonl', async () => {
    const d = await isWriteAllowed(tempDir, 'logs/2026-05-12.jsonl');
    expect(d.allowed).toBe(true);
  });

  it('allows campaigns/<id>/logs/<date>.jsonl', async () => {
    const d = await isWriteAllowed(tempDir, 'campaigns/q1/logs/2026-05-12.jsonl');
    expect(d.allowed).toBe(true);
  });

  it('refuses campaigns/<id>/notes.md (non-logs path under campaigns)', async () => {
    const d = await isWriteAllowed(tempDir, 'campaigns/q1/notes.md');
    expect(d.allowed).toBe(false);
  });
});

describe('isWriteAllowed — autonomy.yaml lookup', () => {
  it('allows surfaces listed with mode: full', async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/research-strategies.yaml', '    mode: full'].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/research-strategies.yaml');
    expect(d.allowed).toBe(true);
  });

  it('allows surfaces in mode: append-only and returns the surface config', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/research-strategies.yaml',
        '    mode: append-only',
        '    max_pending: 5',
        '    root_key: strategies',
        '    unique_by: id',
      ].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/research-strategies.yaml');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.mode).toBe('append-only');
      expect(d.surface?.root_key).toBe('strategies');
      expect(d.surface?.unique_by).toBe('id');
      expect(d.surface?.max_pending).toBe(5);
    }
  });

  it('allows surfaces in mode: inline-enrichment and returns the surface config', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    root_key: members',
        '    unique_by: id',
        '    soft_fields:',
        '      - notes',
        '      - last_observed_at',
      ].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/team.yaml');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.mode).toBe('inline-enrichment');
      expect(d.surface?.root_key).toBe('members');
      expect(d.surface?.unique_by).toBe('id');
      expect(d.surface?.soft_fields).toEqual(['notes', 'last_observed_at']);
    }
  });

  it('allows surfaces in mode: bounded and returns the surface config', async () => {
    await writeAutonomy(
      [
        'surfaces:',
        '  - path: lib/warmup.yaml',
        '    mode: bounded',
        '    bounds:',
        '      sends_per_day: { min: 10, max: 100, step: 5 }',
        '      new_thread_ratio: { min: 0.1, max: 0.9 }',
      ].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/warmup.yaml');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.mode).toBe('bounded');
      expect(d.surface?.bounds).toEqual({
        sends_per_day: { min: 10, max: 100, step: 5 },
        new_thread_ratio: { min: 0.1, max: 0.9 },
      });
    }
  });

  it('refuses surfaces not listed in autonomy.yaml', async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: memory/', '    mode: full'].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/team.yaml');
    expect(d.allowed).toBe(false);
  });

  it('refuses surfaces in mode: gated', async () => {
    await writeAutonomy(
      ['surfaces:', '  - path: lib/research-strategies.yaml', '    mode: gated'].join('\n'),
    );
    const d = await isWriteAllowed(tempDir, 'lib/research-strategies.yaml');
    expect(d.allowed).toBe(false);
  });
});

describe('isMcpAllowed', () => {
  it('allows servers explicitly marked allow', async () => {
    await writeAutonomy(['mcps:', '  slack: allow', '  gmail: allow'].join('\n'));
    const d = await isMcpAllowed(tempDir, 'slack');
    expect(d.allowed).toBe(true);
  });

  it('refuses servers explicitly marked deny with a reason mentioning the server', async () => {
    await writeAutonomy(['mcps:', '  slack: deny'].join('\n'));
    const d = await isMcpAllowed(tempDir, 'slack');
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain('slack');
      expect(d.reason).toMatch(/denied/);
    }
  });

  it('refuses unlisted servers (default deny)', async () => {
    await writeAutonomy(['mcps:', '  slack: allow'].join('\n'));
    const d = await isMcpAllowed(tempDir, 'playwright');
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain('playwright');
      expect(d.reason).toMatch(/not declared/);
    }
  });

  it('refuses when autonomy.yaml is missing entirely', async () => {
    const d = await isMcpAllowed(tempDir, 'slack');
    expect(d.allowed).toBe(false);
  });

  it('refuses when the mcps: block is empty', async () => {
    await writeAutonomy(['surfaces:', '  - path: memory/', '    mode: full'].join('\n'));
    const d = await isMcpAllowed(tempDir, 'slack');
    expect(d.allowed).toBe(false);
  });

  it('refuses empty server names', async () => {
    await writeAutonomy(['mcps:', '  slack: allow'].join('\n'));
    const d = await isMcpAllowed(tempDir, '');
    expect(d.allowed).toBe(false);
  });
});

describe('isMcpToolAllowed', () => {
  it('allows every tool when the server is a bare allow', async () => {
    await writeAutonomy('mcps:\n  slack: allow\n');
    expect((await isMcpToolAllowed(tempDir, 'slack', 'post_message')).allowed).toBe(true);
  });

  it('denies every tool when the server is a bare deny', async () => {
    await writeAutonomy('mcps:\n  slack: deny\n');
    expect((await isMcpToolAllowed(tempDir, 'slack', 'post_message')).allowed).toBe(false);
  });

  it('allows a tool named in the allow list', async () => {
    await writeAutonomy('mcps:\n  vault:\n    allow: [write_secret]\n');
    expect((await isMcpToolAllowed(tempDir, 'vault', 'write_secret')).allowed).toBe(true);
  });

  it('denies a tool absent from the allow list', async () => {
    await writeAutonomy('mcps:\n  vault:\n    allow: [write_secret]\n');
    const decision = await isMcpToolAllowed(tempDir, 'vault', 'delete_secret');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('delete_secret');
      expect(decision.reason).toContain('write_secret');
    }
  });

  it('denies an undeclared server', async () => {
    await writeAutonomy('mcps:\n  slack: allow\n');
    expect((await isMcpToolAllowed(tempDir, 'vault', 'write_secret')).allowed).toBe(false);
  });

  it('denies when autonomy.yaml has no mcps block', async () => {
    await writeAutonomy('# no mcps block\n');
    expect((await isMcpToolAllowed(tempDir, 'vault', 'write_secret')).allowed).toBe(false);
  });
});

describe('isMcpAllowed with an object entry', () => {
  it('treats a server carrying an allow list as usable at server level', async () => {
    await writeAutonomy('mcps:\n  vault:\n    allow: [write_secret]\n');
    expect((await isMcpAllowed(tempDir, 'vault')).allowed).toBe(true);
  });
});

describe('the gate never reads more permission than the config states', () => {
  it('denies a tool listed under a deny: key rather than granting it', async () => {
    await writeAutonomy(
      [
        'mcps:',
        '  vault:',
        '    allow:',
        '      - read_secret',
        '    deny:',
        '      - delete_secret',
        '',
      ].join('\n'),
    );
    // The whole entry is unreadable, so `vault` falls through to
    // default-deny — including the tool the operator meant to allow.
    expect((await isMcpToolAllowed(tempDir, 'vault', 'delete_secret')).allowed).toBe(
      false,
    );
    expect((await isMcpToolAllowed(tempDir, 'vault', 'read_secret')).allowed).toBe(false);
    expect((await isMcpAllowed(tempDir, 'vault')).allowed).toBe(false);
  });

  it("denies a tool nested under a typo'd key rather than granting it", async () => {
    await writeAutonomy('mcps:\n  vault:\n    alow:\n      - read_secret\n');
    expect((await isMcpToolAllowed(tempDir, 'vault', 'read_secret')).allowed).toBe(false);
    expect((await isMcpAllowed(tempDir, 'vault')).allowed).toBe(false);
  });

  it('denies a __proto__ server name instead of throwing', async () => {
    await writeAutonomy('mcps:\n  slack: allow\n');
    const tool = await isMcpToolAllowed(tempDir, '__proto__', 'anything');
    expect(tool.allowed).toBe(false);
    expect((await isMcpAllowed(tempDir, '__proto__')).allowed).toBe(false);
  });

  it('denies inherited object keys used as server names instead of throwing', async () => {
    await writeAutonomy('mcps:\n  slack: allow\n');
    for (const name of ['toString', 'constructor', 'hasOwnProperty']) {
      expect((await isMcpToolAllowed(tempDir, name, 'anything')).allowed).toBe(false);
    }
  });

  it('denies when a __proto__ entry tries to reshape the map', async () => {
    await writeAutonomy(
      'mcps:\n  __proto__:\n    allow: [anything]\n  slack: allow\n',
    );
    expect((await isMcpToolAllowed(tempDir, 'allow', 'anything')).allowed).toBe(false);
    expect((await isMcpToolAllowed(tempDir, 'vault', 'anything')).allowed).toBe(false);
    // The legitimate entry alongside it still works.
    expect((await isMcpToolAllowed(tempDir, 'slack', 'post_message')).allowed).toBe(true);
  });
});
