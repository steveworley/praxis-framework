import React from 'react';
import { render } from 'ink';
import { App } from '../app.js';
import { loadCatalog } from '../lib/catalog.js';
import { InitConfigError, runInitConfig } from './init-config.js';

interface InitOptions {
  path?: string;
  /**
   * Path to a JSON file matching `SeedInput`. When set, `praxis init` skips
   * the Ink wizard entirely and seeds the role from the file's contents.
   * The TTY guard is bypassed in this mode — CI / piped contexts are fine.
   */
  config?: string;
  /**
   * Forwarded to `seedRole({ overwrite: true })` in non-interactive mode.
   * Ignored when `--config` is not set, because the wizard owns its own
   * conflict-handling UX.
   */
  overwrite?: boolean;
}

export const initCommand = async (options: InitOptions) => {
  const scaffoldPath = options.path ?? process.cwd();

  // Non-interactive branch — read a JSON config and call `seedRole` directly.
  // We deliberately don't load the framework catalog here: the catalog is the
  // wizard's source of truth for tool/trait options, but a config-driven seed
  // is just "trust the file", so we hand straight off to the seed package.
  if (options.config !== undefined) {
    try {
      const result = await runInitConfig({
        configPath: options.config,
        targetPath: scaffoldPath,
        overwrite: options.overwrite ?? false,
      });
      process.stdout.write(
        `praxis: seeded ${result.filesWritten.length} files to ${result.targetPath}\n`,
      );
      return;
    } catch (err: unknown) {
      const message =
        err instanceof InitConfigError ? err.message : err instanceof Error ? err.message : String(err);
      process.stderr.write(`praxis: ${message}\n`);
      process.exit(1);
    }
  }

  // Interactive branch — Ink's useInput requires raw mode, which only works
  // on a real TTY. Refuse to start cleanly when run under CI, piped input,
  // or any non-interactive context — beats letting the React reconciler
  // crash with an obscure "Raw mode is not supported" stack trace.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'praxis init requires an interactive terminal.\n' +
        'Run it from a real shell — not piped, not in CI, not nested in another process.\n' +
        'For non-interactive use, pass --config <path-to-role.json>.\n',
    );
    process.exit(1);
  }

  // Load the framework catalog up-front. The wizard can't function without
  // it, and surfacing the failure here keeps the Ink tree free of a
  // loading-spinner detour for what should be an instant disk read.
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`praxis: ${message}\n`);
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <App scaffoldPath={scaffoldPath} catalog={catalog} />,
    {
      exitOnCtrlC: true,
    },
  );

  waitUntilExit().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`praxis: ${message}\n`);
    process.exit(1);
  });
};
