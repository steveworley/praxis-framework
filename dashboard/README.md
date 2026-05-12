# Praxis Interior dashboard

Astro + Node SSR. Three surfaces:

- `/setup` — wizard that converts the framework repo into a populated role (two visible commits)
- read-only role-watcher routes (`/`, `/role`, `/escalations`, `/notebook`, `/activity`)
- `/chat` — conversational lens on the role (Anthropic SDK-backed)

`/` redirects to `/setup` when no `persona.md` exists at the role home.

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
| `ANTHROPIC_API_KEY` | _(unset)_ | Required to enable the `/chat` surface. Without it, `/chat` renders a disabled-state empty pane. |
| `PRAXIS_CHAT_MODEL` | `claude-sonnet-4-6` | Overrides the model the chat surface sends requests to. |

## Chat

`/chat` is the operator's conversational surface for the role. The model is fed a system prompt assembled from the role's interior (persona body, available verbs, hard rules from `CLAUDE.md`, the autonomy stance from `lib/autonomy.yaml`, and the tool catalog from `lib/tools.yaml`) so it speaks as the role.

- **Conversations** persist as markdown under `<role-home>/memory/conversations/<thread_id>.md` — inspectable like every other piece of the role's interior.
- **Attachments** uploaded from the composer land under `<role-home>/lib/uploads/<thread_id>/<safe_filename>` and are inlined into the user message when they're small (≤ 10 KB) and text-shaped (`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv`, `.log`). Upload cap is 5 MB.
- **Tool use is intentionally disabled** for v1. The model replies in text only; if it wants to take an action it surfaces what it would do rather than doing it.

## API surface

All endpoints return JSON. Read endpoints exist as routes for parity with the legacy server, but the dashboard pages assemble data server-side via the same loader functions for fewer round-trips.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/persona` | Parses `persona.md` (identity / voice / capabilities / inhibitions) |
| GET | `/api/memory` | Walks `memory/**/*.md`, recency-sorted, README skipped |
| GET | `/api/escalations` | Walks `escalations/*.md`, inlines `proposed_skill` drafts, sorted by status → urgency → date |
| GET | `/api/activity?limit=N` | One entry per line of files matching `PRAXIS_LOG_GLOB` (default 50, max 500) |
| POST | `/api/setup/role` | Wizard submit — seeds the role with two git commits |
| GET | `/api/chat/threads` | Lists conversations under `memory/conversations/`, sorted by `updated` desc |
| POST | `/api/chat/threads` | Creates a new conversation from `{ first_message }` |
| GET | `/api/chat/threads/{id}` | Returns `{ thread, turns[] }` for one conversation |
| DELETE | `/api/chat/threads/{id}` | Removes the conversation file |
| POST | `/api/chat/message` | Runs one chat turn end-to-end (system prompt → Anthropic → persist user + assistant). Returns `{ role, content, timestamp }`. 503 when `ANTHROPIC_API_KEY` is missing. |
| POST | `/api/chat/upload` | Multipart upload; writes the file under `lib/uploads/<thread_id>/` |

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
