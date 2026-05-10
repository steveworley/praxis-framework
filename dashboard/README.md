# Praxis Interior dashboard

Astro + Node SSR. Two surfaces:

- `/setup` — wizard that converts the framework repo into a populated role (two visible commits)
- `/interior` — read-only role-watcher: persona, escalations, notebook, recent activity

`/` redirects to whichever is appropriate based on whether `persona.md` exists at the role home.

## Running locally

```bash
npm install
npm run dev      # default: http://localhost:4321
```

By default the dashboard reads/writes the parent of this directory (the framework repo or the role's repo). Override with `PRAXIS_ROLE_HOME`:

```bash
PRAXIS_ROLE_HOME=/path/to/some-role npm run dev
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PRAXIS_ROLE_HOME` | parent of this directory | Path to the role's directory |
| `PRAXIS_LOG_GLOB` | `*/logs/*.jsonl` | Glob for the activity feed (rooted at the role home) |

## API surface

All endpoints return JSON. Read endpoints exist as routes for parity with the legacy server, but the dashboard pages assemble data server-side via the same loader functions for fewer round-trips.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/persona` | Parses `persona.md` (identity / voice / capabilities / inhibitions) |
| GET | `/api/memory` | Walks `memory/**/*.md`, recency-sorted, README skipped |
| GET | `/api/escalations` | Walks `escalations/*.md`, inlines `proposed_skill` drafts, sorted by status → urgency → date |
| GET | `/api/activity?limit=N` | One entry per line of files matching `PRAXIS_LOG_GLOB` (default 50, max 500) |
| POST | `/api/setup/role` | Wizard submit — seeds the role with two git commits |

## Production build

```bash
npm run build
node ./dist/server/entry.mjs
```

The build produces a standalone Node server in `dist/server/`.

## Tests

```bash
npm run test
```
