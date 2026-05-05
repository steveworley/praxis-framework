# Phase 1: Praxis dashboard (Astro + Node SSR).
#
# The dashboard runs from inside a clone of the framework/role repo. The repo
# is mounted at /role; the container runs the dashboard from /role/dashboard
# and the wizard can write back to /role (which is the host clone).
#
# Build:
#   docker build -t praxis-dashboard -f dashboard/Dockerfile .
#
# Run (mount your praxis-framework checkout, or an already-seeded role, as /role):
#   docker run --rm -p 4321:4321 \
#     -v $(pwd):/role \
#     praxis-dashboard
#
# Or via docker-compose (see docker-compose.yml in the repo root).

FROM node:20-alpine

# git is required by the wizard's seed flow (simple-git).
RUN apk add --no-cache git

# Bind the dev/preview server to all interfaces inside the container.
ENV HOST=0.0.0.0
ENV PORT=4321

EXPOSE 4321

WORKDIR /role/dashboard

# Default command runs the Astro dev server. On first start the container
# installs dependencies into the dashboard/node_modules volume; subsequent
# starts skip the install.
#
# For production, override the command with: npm run build && npm run serve
CMD ["sh", "-c", "[ ! -d node_modules ] && npm install; npm run start"]
