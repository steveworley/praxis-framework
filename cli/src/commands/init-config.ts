import fs from 'node:fs/promises';
import path from 'node:path';

import {
  SeedError,
  SeedInputSchema,
  seedRole,
  type SeedInput,
  type SeedResult,
} from '@praxis/seed';
import { z } from 'zod';

/**
 * Non-interactive seed path for `praxis init --config <file>`.
 *
 * The wizard branch of `praxis init` mounts an Ink tree to capture a
 * `SeedInput` interactively. This module runs the same seed step without
 * any UI — read JSON from disk, validate against `SeedInputSchema`, hand
 * off to `seedRole`. Useful for development iteration, scripted scaffolds,
 * and CI where no TTY is available.
 *
 * Pulled out of `init.tsx` so it can be unit-tested without booting Ink.
 */

export interface InitConfigOptions {
  /** Absolute or cwd-relative path to a JSON file matching `SeedInput`. */
  configPath: string;
  /** Target directory to seed into. Resolved with `path.resolve`. */
  targetPath: string;
  /** If true, overwrite existing files at the target. */
  overwrite?: boolean;
}

/**
 * Typed error class so the commander wrapper can map clean exit codes
 * without leaking stack traces to operator-facing output. The `cause`
 * preserves the underlying error (Zod issue, fs ENOENT, JSON parse fail)
 * for callers that want to inspect it — tests assert on `code` instead.
 */
export class InitConfigError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CONFIG_NOT_FOUND'
      | 'CONFIG_UNREADABLE'
      | 'CONFIG_INVALID_JSON'
      | 'CONFIG_INVALID_SCHEMA'
      | 'SEED_FAILED',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'InitConfigError';
  }
}

/**
 * Read + validate the config file, then call `seedRole`.
 *
 * Errors are normalised into `InitConfigError` so the commander wrapper
 * can write a single-line stderr message and exit non-zero. The result
 * mirrors `seedRole`'s `SeedResult` so callers can format their own
 * success message.
 */
export async function runInitConfig(options: InitConfigOptions): Promise<SeedResult> {
  const input = await loadAndValidateConfig(options.configPath);
  const absTarget = path.resolve(options.targetPath);

  try {
    return await seedRole(input, absTarget, { overwrite: options.overwrite ?? false });
  } catch (err: unknown) {
    if (err instanceof SeedError) {
      throw new InitConfigError(err.message, 'SEED_FAILED', err);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new InitConfigError(`Seed failed: ${message}`, 'SEED_FAILED', err);
  }
}

/**
 * Read the file, parse as JSON, validate against `SeedInputSchema`. Each
 * failure mode gets its own error code so tests can distinguish them
 * cleanly without string-matching messages.
 */
async function loadAndValidateConfig(configPath: string): Promise<SeedInput> {
  const absConfig = path.resolve(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(absConfig, 'utf-8');
  } catch (err: unknown) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      throw new InitConfigError(
        `Config file not found: ${absConfig}`,
        'CONFIG_NOT_FOUND',
        err,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new InitConfigError(
      `Failed to read config file ${absConfig}: ${message}`,
      'CONFIG_UNREADABLE',
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InitConfigError(
      `Config file is not valid JSON (${absConfig}): ${message}`,
      'CONFIG_INVALID_JSON',
      err,
    );
  }

  const result = SeedInputSchema.safeParse(parsed);
  if (!result.success) {
    const summary = formatZodError(result.error);
    throw new InitConfigError(
      `Config does not match SeedInput schema: ${summary}`,
      'CONFIG_INVALID_SCHEMA',
      result.error,
    );
  }
  return result.data;
}

/**
 * Render a Zod issue list as a single line. Mirrors the `seedRole` internal
 * formatter so operators get the same flavour of error from both surfaces.
 */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
