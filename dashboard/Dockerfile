# Production image for the Praxis dashboard.
#
# Multi-stage build: stage 1 installs workspace deps + compiles the seed
# package + builds the dashboard; stage 2 carries the pruned workspace
# layout (root + dashboard node_modules, built seed, built dashboard) and
# serves the Astro Node-SSR standalone output.
#
# The build context is the framework repo root (not dashboard/) because the
# dashboard pulls `@praxis/seed` in via the npm workspace link — resolving
# that requires the workspace root.
#
# Build:
#   docker build -f dashboard/Dockerfile -t praxis-dashboard:local .
#
# Run (mount a role-home directory at /role):
#   docker run --rm -p 4321:4321 \
#     -v /path/to/role:/role \
#     -e PRAXIS_ROLE_HOME=/role \
#     praxis-dashboard:local

# -----------------------------------------------------------------------------
# Stage 1: build
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /repo

# Install workspace deps from the repo root so workspace protocol links
# (`@praxis/seed`) resolve correctly. Copy lockfile + every workspace's
# package.json first so this layer caches when source changes but deps don't.
COPY package.json package-lock.json ./
COPY dashboard/package.json ./dashboard/
COPY cli/package.json ./cli/
COPY packages/seed/package.json ./packages/seed/

RUN npm ci --no-audit --no-fund

# Copy the rest of the workspaces that participate in the build.
COPY packages/seed ./packages/seed
COPY dashboard ./dashboard

# The seed package emits compiled output to packages/seed/dist — the dashboard
# imports that, so it must be built first.
RUN npm run build --workspace=@praxis/seed
RUN npm run build --workspace=praxis-dashboard

# Drop dev dependencies from the workspace tree so the runtime stage carries
# only what's needed to run the server.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine

# git is required by the wizard's seed flow (simple-git).
RUN apk add --no-cache git

WORKDIR /app

# Carry the pruned workspace layout intact. npm hoists what it can to the
# root and leaves the rest (the dashboard's bulk — astro + adapter, etc.)
# under dashboard/node_modules; we need both trees so the dashboard's Node
# resolver can find every runtime dep.
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/seed/package.json ./packages/seed/package.json
COPY --from=builder /repo/packages/seed/dist ./packages/seed/dist
COPY --from=builder /repo/dashboard/package.json ./dashboard/package.json
COPY --from=builder /repo/dashboard/dist ./dashboard/dist
COPY --from=builder /repo/dashboard/node_modules ./dashboard/node_modules

WORKDIR /app/dashboard

ENV HOST=0.0.0.0 \
    PORT=4321 \
    NODE_ENV=production

EXPOSE 4321

CMD ["node", "./dist/server/entry.mjs"]
