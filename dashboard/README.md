# Praxis Interior dashboard

Astro + Node SSR. Five surfaces:

- `/setup` — wizard that converts the framework repo into a populated role (two visible commits)
- read-only role-watcher routes (`/`, `/role`, `/escalations`, `/notebook`, `/activity`)
- `/chat` — conversational lens on the role (Anthropic SDK-backed)
- `/triage` — operator review surface for the role's raise-your-hand outputs (escalations + proposed verbs)
- `/output` — typed work product (document / draft / record / plan / reference)

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

`/chat` is the operator's conversational surface for the persona. The model is fed a system prompt assembled from the role's interior (persona body, available verbs, hard rules from `CLAUDE.md`, the autonomy stance from `lib/autonomy.yaml`, and the tool catalog from `lib/tools.yaml`) so it answers as the persona — addressed by name throughout the UI (the operator writes to Monika, not to "your role").

- **Conversations** persist as markdown under `<role-home>/memory/conversations/<thread_id>.md` — inspectable like every other entry in the persona's notebook.
- **Attachments** uploaded from the composer land under `<role-home>/lib/uploads/<thread_id>/<safe_filename>` and are inlined into the user message when they're small (≤ 10 KB) and text-shaped (`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv`, `.log`). Upload cap is 5 MB.

### Learning loop

The model has nine growth tools available during every chat turn. They write into the role's growth surfaces (the same surfaces a technical operator would write to from Claude Code):

| Tool | Writes to | Refuses on |
|---|---|---|
| `write_memory` | `memory/<category>/<slug>.md` | Existing file (memory is append-only at the file level) |
| `create_escalation` | `escalations/<date>-<random>-<slug>.md` | — (ids include a random suffix to avoid collisions) |
| `propose_verb` | `verbs/proposed/<slug>.md` | Slug already exists in `verbs/` or `verbs/proposed/` |
| `append_entry` | An operator-opened append-only YAML surface (e.g. `lib/research-strategies.yaml`) | Surface not in `autonomy.yaml`, wrong mode, missing `root_key`, duplicate `unique_by`, or `max_pending` reached |
| `enrich_entry` | Declared soft fields on an existing entry in an operator-opened inline-enrichment YAML surface (e.g. `lib/team.yaml`) | Surface not in `autonomy.yaml`, wrong mode, missing `root_key` / `unique_by` / `soft_fields` declaration, no entry with the given id, or a supplied field is outside the whitelist |
| `adjust_param` | A numeric parameter on an operator-opened bounded YAML surface (e.g. `lib/warmup.yaml`) | Surface not in `autonomy.yaml`, wrong mode, missing `bounds` declaration, key not in declared bounds, value below `min` / above `max` / not step-aligned |
| `write_output` | `output/<type>/<slug>.md` (or `output/record/<entity_type>/<entity_id>/<slug>.md`) | File exists, malformed slug, missing required fields per type, channel enum violation for drafts |
| `update_output_status` | An existing file under `output/` | File doesn't exist, status not in the closed enum |
| `log_decision` | `logs/<date>.jsonl` (or `campaigns/<id>/logs/...`) | Unknown campaign id |

Every tool call is gated by `lib/autonomy.yaml` plus a hard-coded constitutional list. Constitutional surfaces (`persona.md`, `verbs/*.md` outside `verbs/proposed/`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, `lib/tools.yaml`, `CLAUDE.md`) are refused regardless of what the yaml says — the chat surface is never the place to mutate the role's constitution.

`append_entry` is the operator-opt-in surface for `mode: append-only` entries in `lib/autonomy.yaml`. Each opened surface declares a `root_key` (the YAML list it appends to), an optional `unique_by` (duplicate-detection field, typically `id`), and an optional `max_pending` (unreviewed-entry ceiling). New entries get `reviewed: false` injected automatically; the operator flips it to `true` after reviewing. When the ceiling is reached, the next append refuses and the model is expected to file an `improvement` escalation asking for compaction. See `docs/autonomy.md` for the full shape.

`enrich_entry` is the operator-opt-in surface for `mode: inline-enrichment` entries. Each opened surface declares `root_key`, `unique_by`, and a `soft_fields` whitelist; the role may update those fields within existing entries but never touch structured fields and never create entries. Hard-field updates and new entries route through escalations.

`adjust_param` is the operator-opt-in surface for `mode: bounded` entries. Each opened surface declares `bounds` — a per-parameter `{min, max, step?}` map naming exactly the keys the role may tune. The surface file is a flat top-level `key: value` YAML map; the role can adjust values within their declared range (and step-aligned when `step` is set). Keys absent from `bounds` are operator-only — `adjust_param` refuses and the model is expected to escalate if the operational ceiling is too tight.

Tool calls persist on the assistant turn via an HTML-comment-fenced JSON block inside the thread markdown file, so the thread stays human-readable while the dashboard can replay calls when the conversation reloads.

### Reflection

The chat pane header has a **Reflect** button. Clicking it asks the persona to walk the reflection beat over the whole thread: memory worth keeping, friction worth escalating, patterns worth proposing as new verbs, decisions worth logging. The model is free to reply with a short summary instead if nothing earned its keep.

## Triage

`/triage` closes the operator-side of the learning loop. When the role files an escalation or proposes a new verb (via chat tools, via Claude Code session, by hand), the operator reviews and resolves it here.

The page has two sections:

- **Open escalations** — `help`, `improvement`, and `proposed_skill` entries with `status: open`. Each card supports **Accept** (with optional operator note), **Decline** (with required reason), and **Comment** (append a note without changing status). All three actions append a timestamped `## Operator note` section to the underlying file so the history reads cleanly.
- **Proposed verbs** — drafts under `verbs/proposed/`. **Accept** moves the draft to `verbs/<slug>.md`, flips frontmatter `status` to `accepted`, and (best-effort) appends a row to `CLAUDE.md`'s verbs table. **Edit before accept** opens an inline textarea so the operator can refine the prompt; **Save only** keeps the edits in `verbs/proposed/`, **Save + accept** writes the refined body straight to the live verb. **Decline** flips the frontmatter `status` to `declined` and records a reason — the file stays in `verbs/proposed/` as a record.

All mutations are atomic (write to tmp + rename) and refuse path-traversal-y ids/slugs. The home page surfaces a "N items in triage" strip when the queue is non-empty, and the nav tab carries a red count badge.

## Audit trail

Every dashboard-mediated mutation lands as a git commit on the role's repo so operators can read `git log` as the role's diary and `git revert <sha>` to roll back any single change.

| Surface | Author | Conventional commit |
|---|---|---|
| Chat-side `write_memory` | `Praxis Role <role@praxis.local>` | `role(memory): note <slug>` |
| Chat-side `create_escalation` | `Praxis Role <role@praxis.local>` | `role(escalation): file <kind> — <slug>` |
| Chat-side `propose_verb` | `Praxis Role <role@praxis.local>` | `role(verb): propose <slug>` |
| Chat-side `append_entry` | `Praxis Role <role@praxis.local>` | `role(lib): append <surface-name>` |
| Chat-side `enrich_entry` | `Praxis Role <role@praxis.local>` | `role(lib): enrich <surface-name>` |
| Chat-side `adjust_param` | `Praxis Role <role@praxis.local>` | `role(lib): adjust <surface-name>:<key>` |
| Chat-side `write_output` | `Praxis Role <role@praxis.local>` | `role(output): write <type> <slug>` |
| Chat-side `update_output_status` | `Praxis Role <role@praxis.local>` | `role(output): status <slug>: <prev> → <next>` |
| Chat-side `log_decision` | `Praxis Role <role@praxis.local>` | `role(decision): log <decision_type>` |
| Triage accept/decline/comment escalation | operator (from `git config`) | `operator(triage): <accept\|decline\|comment> escalation <id>` |
| Triage accept/decline/edit proposed verb | operator (from `git config`) | `operator(triage): <accept\|decline\|edit> proposed verb <slug>` |
| Output status update (dashboard POST) | operator (from `git config`) | `operator(output): status <slug>: <prev> → <next>` |
| Co-author apply (triage/draft) | operator (from `git config`) | `operator(<persona\|claude-md\|verb\|lib>): co-author <summary> (#<escalation_id>)` with `Co-Authored-By: Praxis Role` trailer |

`git log --author=Praxis\ Role` shows everything the role wrote autonomously through chat. `git log --author=<your-email>` shows the operator-side review actions. If the role home isn't yet a git repo when a mutation lands, the audit module auto-initialises one and plants a `chore: praxis init audit baseline` commit attributed to the operator before the mutation's own commit. If the operator's git identity isn't configured, operator-side commits fall back to `Operator <operator@praxis.local>` and the dashboard surfaces a soft warning inviting the operator to set `user.name`/`user.email`.

Failures in the audit-commit path never block the user's primary action — the disk write already succeeded. Chat tool results render the short SHA next to the summary on success (`→ wrote memory/foo.md  abc1234`), and when the commit was skipped the model sees a `(commit skipped: <reason>)` suffix so it can reason about the gap.

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
| GET | `/api/triage/escalations?status=` | List escalations filtered by status (`open`, `accepted`, `declined`, `resolved`, `all`) |
| GET | `/api/triage/escalations/{id}` | Returns the full detail (meta + body) for one escalation |
| POST | `/api/triage/escalations/{id}/accept` | Optional `{ operator_note }`. Flips status to `accepted` and appends an operator-note section |
| POST | `/api/triage/escalations/{id}/decline` | Required `{ reason }`. Flips status to `declined` and records the reason |
| POST | `/api/triage/escalations/{id}/comment` | Required `{ note }`. Appends a note; status unchanged |
| GET | `/api/triage/verbs/proposed` | List of drafts under `verbs/proposed/` (status `proposed` only — declined drafts are filtered out) |
| GET | `/api/triage/verbs/proposed/{slug}` | Full detail of one draft |
| POST | `/api/triage/verbs/proposed/{slug}/accept` | Optional `{ body_override }`. Moves the draft to `verbs/<slug>.md`, updates frontmatter, best-effort appends a row to `CLAUDE.md` |
| POST | `/api/triage/verbs/proposed/{slug}/decline` | Required `{ reason }`. Flips status to `declined`; file stays in `verbs/proposed/` |
| POST | `/api/triage/verbs/proposed/{slug}/edit` | Required `{ body }`. Replaces the body in place; frontmatter preserved |
| GET | `/api/output?type=&status=&entity_type=&entity_id=&limit=` | Lists output entries with optional filters; returns `OutputSummary[]` sorted by `updated` desc |
| GET | `/api/output/{type}/{...slug}` | Loads one entry (records use multi-segment slug); returns `{ meta, body, body_html, frontmatter }` |
| POST | `/api/output/{type}/{...slug}` | Updates status. Body `{ status }` from the closed enum. Operator-attributed audit commit. |

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
