import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Node SSR — the dashboard reads/writes the role-home directory at runtime,
// so static output isn't viable. The wizard's POST /api/setup/role mutates
// the host filesystem and runs git, both of which require server-side execution.
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  server: {
    port: 4321,
    host: true,
  },
  vite: {
    server: {
      // Allow access from the host when running inside the framework repo.
      strictPort: false,
    },
  },
});
