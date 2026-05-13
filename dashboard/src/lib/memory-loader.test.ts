import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleMemory } from './memory-loader.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mem-'));
  await fs.mkdir(path.join(tempDir, 'memory', 'people'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'memory', 'notes'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('assembleMemory', () => {
  it('returns an empty array when memory/ is missing', async () => {
    await fs.rm(path.join(tempDir, 'memory'), { recursive: true });
    expect(await assembleMemory(tempDir)).toEqual([]);
  });

  it('skips top-level README and categorises by subdirectory', async () => {
    await fs.writeFile(path.join(tempDir, 'memory', 'README.md'), '# README', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'memory', 'people', 'alice.md'),
      `---\ncreated: 2026-04-01\nupdated: 2026-05-04\n---\n\n# Alice\n\nNotes about Alice.`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'memory', 'notes', 'thoughts.md'),
      `---\nupdated: 2026-05-05\n---\n\n# Thoughts\n\nbody`,
      'utf-8',
    );
    const entries = await assembleMemory(tempDir);
    expect(entries.map((e) => e.title)).toEqual(['Thoughts', 'Alice']);
    expect(entries.map((e) => e.category)).toEqual(['notes', 'people']);
    expect(entries.every((e) => e.archived === false)).toBe(true);
  });

  it('walks memory/archived/ and tags entries with archived: true', async () => {
    await fs.mkdir(path.join(tempDir, 'memory', 'archived', 'people'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'memory', 'people', 'bob.md'),
      `---\ncreated: 2026-05-01\nupdated: 2026-05-10\n---\n\n# Bob\n\nactive`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'memory', 'archived', 'people', 'carol.md'),
      `---\ncreated: 2025-01-01\nupdated: 2025-01-02\n---\n\n# Carol\n\nstale`,
      'utf-8',
    );
    const entries = await assembleMemory(tempDir);
    const carol = entries.find((e) => e.slug === 'carol');
    expect(carol).toBeDefined();
    expect(carol?.archived).toBe(true);
    // archived/ should not surface as a category — the entry keeps its
    // original `people` category instead.
    expect(carol?.category).toBe('people');
    const categories = new Set(entries.map((e) => e.category));
    expect(categories.has('archived')).toBe(false);
  });
});
