// Copy the framework's root-level `template/` directory into the seed
// package's tree so it ships inside the published tarball. The seed package's
// `files` field includes `template/`, and `src/template.ts` looks for a
// `<package-root>/template/` directory first when resolving the template path.
//
// In the dev monorepo this script keeps `packages/seed/template/` in sync
// with the root `template/`; the copied tree is gitignored so the source of
// truth stays at the repo root. At publish time `prepublishOnly` runs the
// build (which runs this script), so the tarball always carries a fresh copy.

import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', '..', 'template');
const dest = join(here, '..', 'template');

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
