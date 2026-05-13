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

  it('seeds successfully into a non-git directory, auto-initialising the repo', async () => {
    // No initFrameworkCheckout — the dir is empty and non-git, mirroring the
    // docker-run-against-mkdir flow. The seed package owns the `git init`;
    // the dashboard's wizard just runs against the resulting repo. We do
    // need a git identity to be available for the wizard's two commits,
    // which the seed doesn't (and shouldn't) configure — so we set it on
    // the freshly-initialised repo between the seed call and the commits.
    // The simplest way to do that here is to pre-set environment-level
    // identity via `git -c` is not feasible (the dashboard runs bare
    // commits) — so configure local identity right after the seed inits.
    // To exercise the full wizard path without forking the production flow,
    // we point GIT_CONFIG_GLOBAL at a tiny config file with identity in it.
    const globalConfig = path.join(tmp, '.gitconfig.test');
    await fs.writeFile(
      globalConfig,
      '[user]\n\tname = Wizard Test\n\temail = wizard@example.test\n[commit]\n\tgpgsign = false\n',
      'utf-8',
    );
    const prevGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const prevNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    try {
      const before = simpleGit(tmp);
      expect(await before.checkIsRepo()).toBe(false);

      const result = await seedRole(sampleRequest(), {
        roleHome: tmp,
        templateRoot: TEMPLATE_ROOT,
      });

      expect(result.ok).toBe(true);
      expect(result.commits).toEqual([
        'feat: seed role from praxis-framework template',
        'chore: tidy framework-only files post-seed',
      ]);

      const after = simpleGit(tmp);
      expect(await after.checkIsRepo()).toBe(true);
      const log = await after.log();
      expect(log.all.length).toBe(2);
      expect(log.all[0]?.message).toContain('chore: tidy framework-only files post-seed');
      expect(log.all[1]?.message).toContain('feat: seed role from praxis-framework template');
    } finally {
      if (prevGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = prevGlobal;
      if (prevNoSystem === undefined) delete process.env['GIT_CONFIG_NOSYSTEM'];
      else process.env['GIT_CONFIG_NOSYSTEM'] = prevNoSystem;
    }
  });
});
