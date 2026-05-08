# @praxis/cli

The praxis-framework CLI. Operators run `praxis init` *before* deploying any
compose stack — the command walks you through organisation context, role
definition, and (eventually) voice/capabilities/inhibitions, then emits a
configured praxis repo plus `docker-compose.yml` and `.env.example`.

## Status

Phase 1.5 scaffold. Currently implemented:

- `praxis init` renders an Ink wizard
- Welcome → organisation → role definition → path choice flows are wired
- Voice / review steps are stubbed; the seed step (file generation, git
  commits, compose output) is deferred to a later PR
- The research-handoff path is stubbed

## Run from source

```bash
# from the repo root
npm install
npm run cli -- init
```

Or directly:

```bash
cd cli
npm run dev -- init
```

## Build

```bash
npm run build
node dist/index.js init
```

## Test

```bash
npm test
```

Tests cover the Zod form schemas and the step transition helpers. UI
components are not unit-tested at this stage.

## Layout

```
src/
├── index.tsx           # commander entry
├── commands/init.tsx   # renders the wizard
├── app.tsx             # state machine + step routing
├── flows/              # one component per wizard step
├── state/              # Zod schemas + step ordering helpers
├── ui/                 # presentation primitives (header, theme)
└── types/              # ambient module declarations for ink-* packages
                        # without published types
```
