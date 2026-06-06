// Copy the framework's root-level `template/` directory into the seed
// package's BUILD OUTPUT (`dist/template/`) so it ships wherever `dist/` does
// — the published npm tarball AND the dashboard's runtime image, which only
// copies `packages/seed/dist`. `src/template.ts` resolves the template from
// `<dist>/template/` first (i.e. alongside the compiled JS), so the seed
// package is fully self-contained: no consumer needs to copy a loose
// `template/` directory separately.
//
// Runs after `tsc` (see the package `build` script), so `dist/` already exists.
// The copied tree lives under the gitignored `dist/`, so the source of truth
// stays at the repo root.

import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', '..', 'template');
const dest = join(here, '..', 'dist', 'template');

if (!existsSync(source)) {
  console.error(`copy-template: source not found at ${source}`);
  process.exit(1);
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}

cpSync(source, dest, { recursive: true });

// npm pack always strips top-level `.gitignore` from the tarball and prunes
// nested ones too. Rename the template's `.gitignore` → `_gitignore` in the
// published copy so it survives packing; the seed reader falls back to the
// underscored name when the dotted one isn't present.
const dotted = join(dest, '.gitignore');
const renamed = join(dest, '_gitignore');
if (existsSync(dotted)) {
  renameSync(dotted, renamed);
}

console.log(`copy-template: copied ${source} → ${dest}`);
