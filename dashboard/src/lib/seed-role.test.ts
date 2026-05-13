import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRole, type SeedRequest } from './seed-role.ts';

/**
 * Exercises the dashboard's wizard flow end-to-end: the two-commit dance,
 * the framework-only file cleanup, and the role-shaped runtime scaffolding
 * (docker-compose.yml + .env.example) the seed package writes.
 *
 * The dashboard wizard runs inside a framework checkout that already has a
 * dev `docker-compose.yml` at the root (with a `build:` context for HMR).
 * Post-seed, that file should be replaced by the role-shaped one from the
 * template, which references the published GHCR image instead.
 */

const TEMPLATE_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'template',
);

const sampleRequest = (): SeedRequest => ({
  organisation: {
    name: 'Acme Co',
    size: 'small',
    description: 'We sell widgets.',
  },
  role_definition: {
    role_name: 'Pat Example',
    one_sentence_purpose: 'I am the example role used in wizard tests.',
  },
  identity: {},
  voice_traits: [{ trait: 'direct', qualifiers: ['no hedging'] }],
  capabilities: ['I write tests'],
  inhibitions: ['I never ship without coverage'],
  initial_verbs: [],
  tools: [],
});

async function configureLocalIdentity(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig('user.name', 'Wizard Test', false, 'local');
  await git.addConfig('user.email', 'wizard@example.test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
}

/**
 * Set up a framework-checkout-shaped directory: git repo with a pre-existing
 * dev `docker-compose.yml` (the build-context one) and a `template/` dir the
 * tidy step will remove. Mirrors the shape the wizard sees on first run.
 */
async function initFrameworkCheckout(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await configureLocalIdentity(dir);

  // Plant a dev-mode compose at the root — the file the wizard should
  // replace via the seed's `overwrite: true`. Including a `build:` context
  // marker so we can assert it's gone post-seed.
  const devCompose = [
    'services:',
    '  dashboard:',
    '    build:',
    '      context: .',
    '      dockerfile: dashboard/Dockerfile.dev',
    '    image: praxis-dashboard:dev',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), devCompose, 'utf-8');

  // Plant a framework-only `template/` dir so the tidy commit has something to remove.
  await fs.mkdir(path.join(dir, 'template'), { recursive: true });
  await fs.writeFile(path.join(dir, 'template', '.gitkeep'), '', 'utf-8');

  await git.add(['docker-compose.yml', 'template/.gitkeep']);
  await git.raw([
    '-c',
    'user.name=Wizard Test',
    '-c',
    'user.email=wizard@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-gpg-sign',
    '-m',
    'init framework checkout',
  ]);
}

describe('seedRole (dashboard wizard)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-wizard-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('replaces the framework dev compose with the role compose post-seed', async () => {
    await initFrameworkCheckout(tmp);

    const result = await seedRole(sampleRequest(), {
      roleHome: tmp,
      templateRoot: TEMPLATE_ROOT,
    });

    expect(result.ok).toBe(true);
    expect(result.commits).toEqual([
      'feat: seed role from praxis-framework template',
      'chore: tidy framework-only files post-seed',
    ]);

    // The role compose from the template should have replaced the dev one.
    const compose = await fs.readFile(path.join(tmp, 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('ghcr.io/steveworley/praxis-framework/dashboard:main');
    // The dev-mode `build:` context must be gone.
    expect(compose).not.toContain('build:');
    expect(compose).not.toContain('Dockerfile.dev');
  });

  it('writes .env.example alongside the role compose', async () => {
    await initFrameworkCheckout(tmp);

    await seedRole(sampleRequest(), {
      roleHome: tmp,
      templateRoot: TEMPLATE_ROOT,
    });

    const env = await fs.readFile(path.join(tmp, '.env.example'), 'utf-8');
    expect(env).toContain('ANTHROPIC_API_KEY=');
  });

  it('removes the framework template/ directory in the tidy commit', async () => {
    await initFrameworkCheckout(tmp);

    await seedRole(sampleRequest(), {
      roleHome: tmp,
      templateRoot: TEMPLATE_ROOT,
    });

    await expect(fs.access(path.join(tmp, 'template'))).rejects.toThrow();
  });
});
