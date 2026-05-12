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

### Learning loop

The model has four growth tools available during every chat turn. They write into the role's growth surfaces (the same surfaces a technical operator would write to from Claude Code):

| Tool | Writes to | Refuses on |
|---|---|---|
| `write_memory` | `memory/<category>/<slug>.md` | Existing file (memory is append-only at the file level) |
| `create_escalation` | `escalations/<date>-<random>-<slug>.md` | — (ids include a random suffix to avoid collisions) |
| `propose_verb` | `verbs/proposed/<slug>.md` | Slug already exists in `verbs/` or `verbs/proposed/` |
| `log_decision` | `logs/<date>.jsonl` (or `campaigns/<id>/logs/...`) | Unknown campaign id |

Every tool call is gated by `lib/autonomy.yaml` plus a hard-coded constitutional list. Constitutional surfaces (`persona.md`, `verbs/*.md` outside `verbs/proposed/`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/team.yaml`, `lib/autonomy.yaml`, `CLAUDE.md`) are refused regardless of what the yaml says — the chat surface is never the place to mutate the role's constitution.

Tool calls persist on the assistant turn via an HTML-comment-fenced JSON block inside the thread markdown file, so the thread stays human-readable while the dashboard can replay calls when the conversation reloads.

### Reflection

The chat pane header has a **Reflect** button. Clicking it asks the role to walk the reflection beat over the whole thread: memory worth keeping, friction worth escalating, patterns worth proposing as new verbs, decisions worth logging. The model is free to reply with a short summary instead if nothing earned its keep.

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
| POST | `/api/chat/message` | Runs one chat turn end-to-end (system prompt → Anthropic tool-use loop → persist user + assistant). Returns `{ role, content, timestamp, toolCalls, truncated }`. 503 when `ANTHROPIC_API_KEY` is missing. |
| POST | `/api/chat/reflect` | Asks the role to reflect on a thread. Same loop as `/message` but seeded with the reflection prompt and the full conversation; persists the reflection as another assistant turn. |
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
