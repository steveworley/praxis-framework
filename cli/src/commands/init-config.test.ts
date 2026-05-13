import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InitConfigError, runInitConfig } from './init-config.js';

/**
 * End-to-end tests for the non-interactive seed path. We exercise the real
 * `seedRole` from `@praxis/seed` against the live framework template, mirroring
 * the seed package's own test strategy — if anyone breaks the template, this
 * suite catches it too.
 */

const sampleConfig = {
  organisation: { name: 'Acme BD', size: 'small' },
  role_definition: {
    role_name: 'sales-lead',
    working_title: 'Sales lead',
    one_sentence_purpose: "drives outbound on Acme's flagship product",
    day_to_day:
      'drafts cold outreach, reviews replies, escalates complex deals',
  },
  tools: ['websearch', 'mcp:google-workspace'],
  voice_traits: [
    { trait: 'direct', qualifiers: ['short sentences, no hedging'] },
  ],
  capabilities: ['drafts cold-outreach emails'],
  inhibitions: ['never quote prices without sign-off'],
  initial_verbs: [
    {
      slug: 'draft-cold-emails',
      description: ['compose an outreach email per prospect'],
    },
  ],
};

describe('runInitConfig', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-init-config-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('seeds a role from a valid JSON config file', async () => {
    const configPath = path.join(tmp, 'role.json');
    const targetPath = path.join(tmp, 'out');
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(sampleConfig), 'utf-8');

    const result = await runInitConfig({ configPath, targetPath });

    expect(result.targetPath).toBe(path.resolve(targetPath));
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect(result.filesWritten).toContain('persona.md');
    expect(result.filesWritten).toContain('CLAUDE.md');
    expect(result.filesWritten).toContain('verbs/draft-cold-emails.md');

    // Cross-check one file lands on disk with operator content injected.
    const persona = await fs.readFile(path.join(targetPath, 'persona.md'), 'utf-8');
    expect(persona).toContain('sales-lead');
    expect(persona).toContain('Acme BD');
  });

  it('rejects when the config file is missing', async () => {
    const configPath = path.join(tmp, 'does-not-exist.json');
    const targetPath = path.join(tmp, 'out');

    await expect(runInitConfig({ configPath, targetPath })).rejects.toMatchObject({
      name: 'InitConfigError',
      code: 'CONFIG_NOT_FOUND',
    });
  });

  it('rejects when the config file is not valid JSON', async () => {
    const configPath = path.join(tmp, 'role.json');
    const targetPath = path.join(tmp, 'out');
    await fs.writeFile(configPath, '{ this is not valid JSON', 'utf-8');

    await expect(runInitConfig({ configPath, targetPath })).rejects.toMatchObject({
      name: 'InitConfigError',
      code: 'CONFIG_INVALID_JSON',
    });
  });

  it('rejects when the config does not match the SeedInput schema', async () => {
    const configPath = path.join(tmp, 'role.json');
    const targetPath = path.join(tmp, 'out');
    // Missing required fields — organisation.name, role_definition, voice_traits.
    await fs.writeFile(configPath, JSON.stringify({ organisation: {} }), 'utf-8');

    const err = await runInitConfig({ configPath, targetPath }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitConfigError);
    expect((err as InitConfigError).code).toBe('CONFIG_INVALID_SCHEMA');
    // Sanity-check the message mentions at least one missing path.
    expect((err as InitConfigError).message).toContain('organisation');
  });

  it('passes --overwrite through to seedRole', async () => {
    const configPath = path.join(tmp, 'role.json');
    const targetPath = path.join(tmp, 'out');
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(sampleConfig), 'utf-8');

    // First seed populates the dir.
    await runInitConfig({ configPath, targetPath });

    // Second run without overwrite should fail with a SeedError-mapped error.
    await expect(runInitConfig({ configPath, targetPath })).rejects.toMatchObject({
      name: 'InitConfigError',
      code: 'SEED_FAILED',
    });

    // Same run with overwrite should succeed.
    const result = await runInitConfig({
      configPath,
      targetPath,
      overwrite: true,
    });
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });
});
