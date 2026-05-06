import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror tsconfig.json paths so tests can import API routes that use `@/…`.
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
});
