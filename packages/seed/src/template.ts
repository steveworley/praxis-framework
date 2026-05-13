import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SeedError } from './types.js';

/**
 * Resolve the framework `template/` directory.
 *
 * Resolution order:
 *   1. Explicit override (`override` arg).
 *   2. `<package-root>/template/` — for when a published build bundles the
 *      template alongside the compiled JS (out of scope for the v0 monorepo
 *      layout, but supported so we don't paint ourselves into a corner).
 *   3. Walk up from the package directory looking for a `template/` sibling.
 *      Handles the monorepo-dev case: `packages/seed/dist/` → `packages/seed/`
 *      → `packages//` → repo-root, where `template/` lives.
 *
 * Throws `SeedError('TEMPLATE_MISSING')` if nothing matches.
 */
export function resolveTemplatePath(override?: string): string {
  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new SeedError(`Template override path does not exist: ${override}`, 'TEMPLATE_MISSING');
    }
    return path.resolve(override);
  }

  // src/template.ts (dev) → src/ → packages/seed/
  // dist/template.js (build) → dist/ → packages/seed/
  const here = fileURLToPath(new URL('.', import.meta.url));
  const packageRoot = path.resolve(here, '..');

  const bundled = path.join(packageRoot, 'template');
  if (existsSync(bundled)) return bundled;

  // Walk up from packageRoot looking for `template/`.
  let cursor = packageRoot;
  // 6 levels is plenty — we're typically 2 levels deep in the monorepo.
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(cursor, 'template');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  throw new SeedError(
    'Could not locate a praxis template/ directory. Pass `templatePath` in SeedOptions to override.',
    'TEMPLATE_MISSING',
  );
}
