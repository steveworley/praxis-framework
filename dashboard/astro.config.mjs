import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Node SSR — the dashboard reads/writes the role-home directory at runtime,
// so static output isn't viable. The wizard's POST /api/setup/role mutates
// the host filesystem and runs git, both of which require server-side execution.
export default defineConfig({
  output: 'server',
  // Astro's built-in origin check bakes `allowedDomains` into the build manifest
  // at build time. This image is prebuilt and deployed behind reverse proxies on
  // arbitrary consumer domains, so build-time config can't apply — Astro would
  // reconstruct the origin as https://localhost and reject every proxied form
  // POST. Origin/CSRF enforcement is handled at runtime in src/middleware.ts via
  // src/lib/csrf.ts (X-Forwarded-Host aware + PRAXIS_ALLOWED_ORIGINS allowlist).
  security: {
    checkOrigin: false,
  },
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
