import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EMBEDDED_TEMPLATE } from './template-data.generated.js';
import { SeedError } from './types.js';

/**
 * Resolve a praxis `template/` directory to seed a role from.
 *
 * Two modes:
 *
 *   1. **Override** (`override` arg supplied): validate that the path exists
 *      and return its absolute form. Used by tests and any caller that wants
 *      to seed from a specific on-disk template. Throws
 *      `SeedError('TEMPLATE_MISSING')` if the path doesn't exist.
 *
 *   2. **Default** (no `override`): materialise the template that is *embedded*
 *      into this package (`template-data.generated.ts`) into a fresh temp
 *      directory and return that directory. This makes seeding work regardless
 *      of how the package is bundled — the dashboard bundles this package,
 *      which breaks `import.meta.url`-based disk resolution, so the scaffolding
 *      travels with the code as data rather than as files we have to locate.
 *
 *      The returned temp dir is the caller's to clean up. `seedRole` does this
 *      best-effort when it owns the lifecycle (i.e. no `templatePath` override).
 *
 * Kept synchronous: callers resolve the path synchronously.
 */
export function resolveTemplatePath(override?: string): string {
  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new SeedError(`Template override path does not exist: ${override}`, 'TEMPLATE_MISSING');
    }
    return path.resolve(override);
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'praxis-template-'));
  for (const entry of EMBEDDED_TEMPLATE) {
    const dst = path.join(tmpDir, entry.path);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, Buffer.from(entry.base64, 'base64'));
    chmodSync(dst, entry.mode);
  }
  return tmpDir;
}
