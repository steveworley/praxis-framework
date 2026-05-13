import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleEscalations } from './escalations-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-esc-'));
  await fs.mkdir(path.join(tempDir, 'escalations'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('assembleEscalations', () => {
  it('returns empty when escalations dir is missing', async () => {
    await fs.rm(path.join(tempDir, 'escalations'), { recursive: true });
    const result = await assembleEscalations(tempDir);
    expect(result.entries).toEqual([]);
    expect(result.countsByStatus).toEqual({ open: 0, resolved: 0, accepted: 0, declined: 0 });
  });

  it('skips README.md and inlines proposed_skill drafts', async () => {
    await fs.writeFile(
      path.join(tempDir, 'escalations', 'README.md'),
      '# README',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'proposed', 'shiny-thing.md'),
      'draft body content',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'escalations', '2026-05-01-shiny.md'),
      `---\nkind: proposed_skill\nurgency: normal\ncreated: 2026-05-01\nstatus: open\nproposed_skill: verbs/proposed/shiny-thing.md\n---\n\n# Shiny thing\n\nbody`,
      'utf-8',
    );
    const result = await assembleEscalations(tempDir);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.kind).toBe('proposed_skill');
    expect(entry?.proposed_skill_path).toBe('verbs/proposed/shiny-thing.md');
    expect(entry?.proposed_skill_body).toBe('draft body content');
    expect(result.countsByStatus.open).toBe(1);
  });

  it('refuses to inline drafts outside verbs/proposed (path traversal)', async () => {
    await fs.writeFile(path.join(tempDir, 'secret.md'), 'leaked', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'escalations', '2026-05-01-evil.md'),
      `---\nkind: proposed_skill\ncreated: 2026-05-01\nstatus: open\nproposed_skill: ../secret.md\n---\n# evil`,
      'utf-8',
    );
    const result = await assembleEscalations(tempDir);
    expect(result.entries[0]?.proposed_skill_body).toBeNull();
  });

  it('sorts open before resolved, then by urgency', async () => {
    await fs.writeFile(
      path.join(tempDir, 'escalations', '2026-05-01-a.md'),
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: resolved\n---\n# A`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'escalations', '2026-05-02-b.md'),
      `---\nkind: help\nurgency: high\ncreated: 2026-05-02\nstatus: open\n---\n# B`,
      'utf-8',
    );
    const result = await assembleEscalations(tempDir);
    expect(result.entries.map((e) => e.title)).toEqual(['B', 'A']);
  });
});
