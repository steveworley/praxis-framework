# The Praxis dashboard

Astro + Node SSR. Three surfaces:

- **`/setup`** — the wizard that converts the framework repo into a populated role. Writes two visible git commits.
- **Read-only supervisor routes** (`/`, `/role`, `/escalations`, `/notebook`, `/activity`) — watch a populated role.
- **`/chat`** — conversational lens on the role, backed by the Anthropic SDK. The non-technical operator's runtime.

`/` redirects to `/setup` when no `persona.md` exists at the role-home root.

The dashboard lives inside the framework repo at `dashboard/`. When the framework is cloned into a new role, the dashboard travels with it — each role has its own dashboard, no separate hosting required.

## Running locally

```bash
cd dashboard
npm install
npm run dev
```

Default URL: `http://localhost:4321/`.

## Running via Docker (Phase 1)

```bash
docker compose up
```

From the framework/role repo root. Mounts the repo as `/role` inside the container; the dashboard runs from `/role/dashboard`. Wizard writes back to the host clone through the volume mount. See [`../docker-compose.yml`](../docker-compose.yml) and [`../dashboard/Dockerfile`](../dashboard/Dockerfile).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PRAXIS_ROLE_HOME` | parent of `dashboard/` | Path to the role's directory. Override only for unusual setups. |
| `PRAXIS_LOG_GLOB` | `*/logs/*.jsonl` | Glob for the activity feed (rooted at `PRAXIS_ROLE_HOME`) |
| `ANTHROPIC_API_KEY` | _(unset)_ | Required to enable `/chat`. When unset, the chat page renders a disabled-state empty pane. |
| `PRAXIS_CHAT_MODEL` | `claude-sonnet-4-6` | Model the chat surface routes requests to. |

### Activity glob nesting

The default `*/logs/*.jsonl` matches a two-segment work-product structure: `{work-product}/logs/{date}.jsonl`. If your role uses a deeper nesting — for example `campaigns/{id}/logs/{date}.jsonl` (three segments, used by the Sam reference role) — set `PRAXIS_LOG_GLOB="*/*/logs/*.jsonl"` instead. The default suits the simplest possible work-product layout; adjust per role.

## API surface

All endpoints return JSON. Read endpoints exist for parity / external consumers, but the dashboard pages assemble data server-side via the same loader functions for fewer round-trips.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/persona` | Parses `persona.md` (Identity / Voice & Personality / Capabilities / Hard inhibitions sections) |
| GET | `/api/memory` | Walks `memory/**/*.md` recursively; top-level `README.md` is skipped; subdirs become categories |
| GET | `/api/escalations` | Walks `escalations/*.md`; inlines `proposed_skill` drafts from `verbs/proposed/`; sorted by status → urgency → date |
| GET | `/api/activity?limit=N` | One entry per line of files matching `PRAXIS_LOG_GLOB` (default 50, capped at 500) |
| POST | `/api/setup/role` | Wizard submit — seeds the role with two git commits |
| GET, POST | `/api/chat/threads` | List or create a conversation |
| GET, DELETE | `/api/chat/threads/{id}` | Read or remove one conversation |
| POST | `/api/chat/message` | Run a chat turn; 503 when `ANTHROPIC_API_KEY` is missing |
| POST | `/api/chat/upload` | Attach a file (≤ 5 MB) to a conversation under `lib/uploads/<thread_id>/` |

## What the dashboard reads

| Surface | Source files | Notes |
|---|---|---|
| Persona / hero | `persona.md` | Looks for `## Identity`, `## Voice & Personality`, `## Capabilities`, `## Hard inhibitions` headers with bulleted children |
| Memory | `memory/**/*.md` | Recency-sorted; filterable by category subdir |
| Escalations | `escalations/*.md` | Sorted by status (open first) → urgency → date desc; filterable by status |
| Activity | files matching `PRAXIS_LOG_GLOB` | Recent verb runs |

The dashboard handles missing files gracefully — section-by-section error handling, one failed loader doesn't blank the page.

## Chat

`/chat` is the operator-facing conversational surface for the role. It re-reads the role's interior on every turn so the model embodies the role as it currently stands — refinements to `persona.md`, new entries in `lib/autonomy.yaml`, and proposed verbs all take effect on the next message without restarting anything.

What the chat reads when assembling the system prompt:

| Source | What goes into the prompt |
|---|---|
| `persona.md` | Full body (sans H1) — voice, identity, capabilities, hard inhibitions |
| `verbs/*.md` | Slug + one-liner per live verb (from frontmatter `summary:` / `description:` / `purpose:`, or the first non-heading line) |
| `CLAUDE.md` § Hard rules | The hard-rules block (matched on `## Hard rules` heading, sliced to the next section) |
| `lib/autonomy.yaml` | Open surfaces (`mode != gated`) become the allow list; `persona.md`, `verbs/*.md`, `CLAUDE.md`, and `lib/*` stay on the deny list regardless |
| `lib/tools.yaml` | Capability name + description per entry |

Conversations land at `<role-home>/memory/conversations/<thread_id>.md` in the same markdown shape as every other piece of the role's interior. Operators can grep, diff, or hand-edit them.

Attachments uploaded from the composer land at `<role-home>/lib/uploads/<thread_id>/<safe_filename>` (≤ 5 MB per file). Text-shaped attachments under 10 KB are inlined into the user message; everything else is referenced by path.

The chat does NOT have tool use in v1 — the model replies in text only. When it wants to take an action it surfaces what it would do rather than doing it.

## What the wizard writes

When the operator submits `/setup`, two commits land on the role's repo:

**Commit 1 — `feat: seed role from praxis-framework template`**

Populates the role from `template/`:
- `CLAUDE.md` — operating manual with `{ROLE_NAME}` substituted and the operator's role description injected
- `persona.md` — identity / voice / capabilities / inhibitions populated from the wizard's fields (at the role root)
- `verbs/escalate.md`, `verbs/proposed/README.md` — copied verbatim with substitutions
- `memory/{people,accounts,notes}/.gitkeep` plus `memory/README.md`
- `escalations/README.md`
- `lib/.gitkeep`
- `.gitignore`
- Optional starter verb stubs at `verbs/{slug}.md` if the operator listed any

**Commit 2 — `chore: tidy framework-only files post-seed`**

Removes:
- `template/` (entire directory — seed material no longer needed)
- `examples/` (framework reference, irrelevant inside a role)
- `scripts/new-role.sh` (CLI bootstrap, replaced by the wizard — only this file is removed; `scripts/` itself stays if it contains anything else)

Replaces:
- `README.md` — the framework's README is replaced with a role-shaped one ("# {Role name}", built-with-Praxis attribution, run instructions)

Both commits are visible in `git log` and can be reverted independently. The wizard refuses to seed if the working tree has uncommitted changes — it won't clobber existing work.

## Phase progression

- **Phase 0** (shipped): read-only role-watcher, hosted via Astro on the host
- **Phase 1** (shipped — Dockerfile + compose): dockerized; framework repo mounted as a volume
- **Phase 3** (shipped — the wizard): role-planning UX in `/setup`; converts the framework into a populated role
- **Phase 2 (chat MVP)** (shipped): `/chat` ships the non-technical operator's conversational runtime; persona-as-system-prompt; persisted conversations under `memory/conversations/`. Tool use deferred to a follow-up.
- **Phase 4** (planned): verb-tag taxonomy from verb frontmatter, verbs grouped by tag in the dashboard

## What it isn't

- Not a control plane — operators read but can't currently resolve / accept / decline escalations from the UI. (Escalation acceptance is an operator-edits-the-file action today.)
- Not multi-role — one dashboard instance, one role. Multi-role = multiple framework clones.
- Not a search interface — feeds are linear. Use grep against the role-home for targeted lookups.
