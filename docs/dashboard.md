# The Praxis dashboard

Astro + Node SSR. Five surfaces:

- **`/setup`** — the wizard that converts the framework repo into a populated role. Writes two visible git commits.
- **Read-only supervisor routes** (`/`, `/role`, `/escalations`, `/notebook`, `/activity`) — watch a populated role.
- **`/chat`** — conversational lens on the role, backed by the Anthropic SDK. The non-technical operator's runtime.
- **`/triage`** — operator review surface for the role's raise-your-hand outputs (escalations + proposed verbs). Closes the operator-side of the learning loop.
- **`/output`** — the typed work-product surface. Five primitives (document, draft, record, plan, reference) with per-type renderers and a closed-enum status lifecycle.

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
| `PRAXIS_LOG_GLOB` | `**/logs/*.jsonl` | Glob for the activity feed (rooted at `PRAXIS_ROLE_HOME`). Globstar matches root `logs/`, single-segment `<wp>/logs/`, and Sam-style nested `<wp>/<id>/logs/`. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Required to enable `/chat`. When unset, the chat page renders a disabled-state empty pane. |
| `PRAXIS_CHAT_MODEL` | `claude-sonnet-4-6` | Model the chat surface routes requests to. |

### Activity glob nesting

The default `**/logs/*.jsonl` uses globstar to match any depth — root-level `logs/{date}.jsonl` (the chat surface's default destination for `log_decision`), `{work-product}/logs/{date}.jsonl`, and Sam-style `campaigns/{id}/logs/{date}.jsonl` all light up without per-role tuning. Override only when you want to narrow it (e.g. `PRAXIS_LOG_GLOB="campaigns/*/logs/*.jsonl"` to filter out everything but campaign activity).

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
| POST | `/api/chat/message` | Run a chat turn; runs the tool-use loop and persists tool calls onto the assistant turn; 503 when `ANTHROPIC_API_KEY` is missing |
| POST | `/api/chat/reflect` | Run the reflection beat on a thread; same loop as `/message` but seeded with the reflection prompt and the full conversation |
| POST | `/api/chat/upload` | Attach a file (≤ 5 MB) to a conversation under `lib/uploads/<thread_id>/` |
| GET | `/api/triage/escalations?status=` | List escalations filtered by status |
| GET | `/api/triage/escalations/{id}` | Full detail (meta + body) for one escalation |
| POST | `/api/triage/escalations/{id}/accept` | Optional `{operator_note}`; flips to `accepted`, appends a note |
| POST | `/api/triage/escalations/{id}/decline` | Required `{reason}`; flips to `declined`, records the reason |
| POST | `/api/triage/escalations/{id}/comment` | Required `{note}`; appends a note, status unchanged |
| GET | `/api/triage/verbs/proposed` | List of `verbs/proposed/` drafts (declined drafts filtered out) |
| GET | `/api/triage/verbs/proposed/{slug}` | Full detail of one draft |
| POST | `/api/triage/verbs/proposed/{slug}/accept` | Optional `{body_override}`; moves to `verbs/<slug>.md`, best-effort appends to CLAUDE.md verbs table |
| POST | `/api/triage/verbs/proposed/{slug}/decline` | Required `{reason}`; flips to `declined`, keeps file in place |
| POST | `/api/triage/verbs/proposed/{slug}/edit` | Required `{body}`; replaces draft body, frontmatter preserved |
| POST | `/api/triage/propose` | Body `{escalation_id, hint?}`; the model reads the role's files and proposes 1..N file changes via the `propose_file_change` tool. Returns `{escalation_id, proposals: FileProposal[], summary, truncated?}` where each `FileProposal` carries `{path, current_content, proposed_content, diff_unified, rationale, kind}`. No disk write; the operator reviews before applying. |
| POST | `/api/triage/apply` | Body `{escalation_id, proposals: [{path, proposed_content}, ...]}`; atomically writes every file (best-effort revert on partial failure) and creates ONE operator-attributed commit covering the whole set with a `Co-Authored-By: Praxis Role` trailer. Returns `{ok, commit_sha, commit_short_sha, files_changed, commit_warning?}`. |
| GET | `/api/output?type=&status=&entity_type=&entity_id=&limit=` | List output entries, filterable by type / status / entity. Returns `OutputSummary[]` sorted by `updated` desc. |
| GET | `/api/output/{type}/{...slug}` | Load one entry. For records, `{...slug}` is `<entity_type>/<entity_id>/<slug>`. Returns `{meta, body, body_html, frontmatter}`. |
| POST | `/api/output/{type}/{...slug}` | Update status. Body `{status}` where status is one of the closed lifecycle enum. Operator-attributed commit via audit. |

## What the dashboard reads

| Surface | Source files | Notes |
|---|---|---|
| Persona / hero | `persona.md` | Looks for `## Identity`, `## Voice & Personality`, `## Capabilities`, `## Hard inhibitions` headers with bulleted children |
| Memory | `memory/**/*.md` | Recency-sorted; filterable by category subdir |
| Escalations | `escalations/*.md` | Sorted by status (open first) → urgency → date desc; filterable by status |
| Activity | files matching `PRAXIS_LOG_GLOB` | Recent verb runs |

The dashboard handles missing files gracefully — section-by-section error handling, one failed loader doesn't blank the page.

## Chat

`/chat` is the operator-facing conversational surface for the persona. The UI addresses the persona by name throughout (placeholder, empty state, turn labels, reflect tooltip) — the operator writes to the person they named, not "your role". The model re-reads the role's interior on every turn so the persona embodies the role as it currently stands — refinements to `persona.md`, new entries in `lib/autonomy.yaml`, and proposed verbs all take effect on the next message without restarting anything.

What the chat reads when assembling the system prompt:

| Source | What goes into the prompt |
|---|---|
| `persona.md` | Full body (sans H1) — voice, identity, capabilities, hard inhibitions |
| `verbs/*.md` | Slug + one-liner per live verb (from frontmatter `summary:` / `description:` / `purpose:`, or the first non-heading line) |
| `CLAUDE.md` § Hard rules | The hard-rules block (matched on `## Hard rules` heading, sliced to the next section) |
| `lib/autonomy.yaml` | Open surfaces (`mode != gated`) become the allow list; the hard-coded `CONSTITUTIONAL_PATHS` (`persona.md`, `CLAUDE.md`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, `lib/tools.yaml`) plus direct `.md` children of `verbs/` stay on the deny list regardless. Other `lib/*` files follow whatever `lib/autonomy.yaml` declares for them. |
| `lib/tools.yaml` | Capability name + description per entry |

Conversations land at `<role-home>/memory/conversations/<thread_id>.md` in the same markdown shape as every other entry in the persona's notebook. Operators can grep, diff, or hand-edit them.

Attachments uploaded from the composer land at `<role-home>/lib/uploads/<thread_id>/<safe_filename>` (≤ 5 MB per file). Text-shaped attachments under 10 KB are inlined into the user message; everything else is referenced by path.

### The learning loop

The chat surface is where the non-technical operator's role *grows*. Every chat turn runs an Anthropic tool-use loop with a typed toolset exposed to the model, sorted into three groups by intent:

| Group | Tool | Writes to |
|---|---|---|
| Growth | `write_memory` | `memory/<category>/<slug>.md` |
| Growth | `create_escalation` | `escalations/<date>-<random>-<slug>.md` |
| Growth | `propose_verb` | `verbs/proposed/<slug>.md` |
| Growth | `log_decision` | `logs/<date>.jsonl` or `campaigns/<id>/logs/...` |
| Lib surgery | `append_entry` | operator-opened `append-only` YAML surface (e.g. `lib/research-strategies.yaml`) |
| Lib surgery | `enrich_entry` | operator-opened `inline-enrichment` YAML surface (e.g. `lib/team.yaml`) |
| Lib surgery | `adjust_param` | operator-opened `bounded` YAML surface (e.g. `lib/warmup.yaml`) |
| Work product | `write_output` | `output/<type>/<slug>.md` (records nest under `<entity_type>/<entity_id>/`) |
| Work product | `update_output_status` | status frontmatter on an existing `output/<type>/<slug>.md` |

Every tool call is gated by `lib/autonomy.yaml` *and* a hard-coded constitutional list. Constitutional surfaces — `persona.md`, `CLAUDE.md`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, `lib/tools.yaml`, plus direct `.md` children of `verbs/` (live playbooks, not `verbs/proposed/`) — are refused regardless of yaml. Other `lib/*` files are operator-opened: the role can write to them in whichever mode `lib/autonomy.yaml` declares.

Tool calls persist on the assistant turn as an HTML-comment-fenced JSON block inside the thread markdown file; the dashboard renders them inline below the turn label. Refusals (gated surface, duplicate slug, malformed input) render in the warning colour and tell the model why — the model can adjust and try again.

### Reflection

The chat pane header has a **Reflect** button. The reflection trigger is *manual*, not per-turn: the operator decides when a conversation has reached a natural reflection point and clicks. The model is then prompted to walk the four-question reflection beat over the whole thread — memory worth keeping, friction worth escalating, patterns worth proposing as verbs, decisions worth logging — and is free to reply with a brief summary if nothing earned its keep. The reflection block is persisted as another assistant turn so it survives reloads.

The dashboard now closes the learning loop for non-technical operators: the role grows visibly in memory/escalations/proposed verbs/decision logs through conversation alone, with the same audit trail a technical operator's Claude Code session would produce.

## Triage

`/triage` is the operator's review surface for the role's raise-your-hand outputs — the matching half of the learning loop. The role files escalations and proposes verbs; the operator reviews and resolves them here.

Two sections, both backed by the typed `/api/triage/*` routes:

- **Open escalations** — `help` / `improvement` / `proposed_skill` entries with `status: open`, sorted by urgency. Each card supports **Accept** (with an optional operator note), **Decline** (with a required reason), and **Comment** (append a note while keeping status open). All three actions append a timestamped `## Operator note` section to the escalation file so the file's history reads as a conversation rather than a state machine.
- **Proposed verbs** — drafts under `verbs/proposed/` with `status: proposed`. **Accept** atomically moves `verbs/proposed/<slug>.md` to `verbs/<slug>.md`, sets frontmatter `status: accepted`, and (best-effort) appends a row to `CLAUDE.md`'s verbs table. **Edit before accept** opens an inline textarea pre-filled with the draft body — operators can refine the prompt before promoting, then either **Save only** (keep refinements in `proposed/` without accepting) or **Save + accept** (the refined body goes straight into the new live verb). **Decline** flips the draft's frontmatter `status` to `declined` and records a reason; the file stays in `verbs/proposed/` as a record of what didn't make the cut.

Every mutation is atomic (write-to-tmp + rename), every id/slug is regex-validated and path-traversal-checked, and the home page surfaces a "N items in triage" strip when the queue is non-empty. The nav tab carries a count badge.

### Co-authoring constitutional changes (`/triage/draft/<id>`)

Improvement escalations that land on constitutional surfaces (persona, CLAUDE.md, a live verb, a `lib/*` file) often deserve to become an actual text change, not just an "accepted, will action later" note. The triage card for each `improvement` escalation includes a **Have <persona> draft a proposal →** link that opens `/triage/draft/<escalation_id>`.

The page is single-pane and proposal-review-shaped (not picker-shaped). The operator never picks a target file or writes a directive — the model decides which file(s) to change, based on the escalation alone:

- **Escalation context** at top — the body rendered as prose, kind + urgency badges, date.
- **Draft button** — when the page first loads. Clicking it sends the escalation id to `/api/triage/propose`; the model reads the role's files (persona, CLAUDE.md, every live verb, non-constitutional libs), then calls `propose_file_change` 1..N times to propose a coherent multi-file change set, ending with a one-paragraph summary.
- **Proposal cards** — one per proposed file, each showing the path + kind badge (persona / CLAUDE.md / verb / lib), the model's one-sentence rationale, and a tabbed view (Diff / Edit inline). A small `×` button drops a file from the apply set. The diff renders with per-line backgrounds (additions green, removals red, hunk headers info-purple).
- **Re-draft hint** — an optional "anything else to tell <persona>?" textarea. Used when the operator clicks **Re-draft** for a fresh proposal with extra guidance.
- **Action row** — **Apply all (N files)** (primary), **Re-draft**, **Discard**.

The flow bypasses the chat tools' autonomy gate by design: the operator is the actor, the model is just a drafting assistant. Apply commits the whole set as ONE operator-attributed commit with the trailer `Co-Authored-By: Praxis Role <role@praxis.local>`, so `git log --grep='Co-Authored-By: Praxis Role'` recovers every co-authored edit. Drop / Re-draft / Edit inline / Discard are all in-page operations; nothing is persisted server-side until **Apply all** lands.

The applied escalation isn't auto-resolved — the operator can comment on it (or close it) from `/triage` separately. The audit trail is the commit + the escalation; we don't need a second state mutation.

## Output

`/output` is the role's work-product surface. The framework ships five primitives (`document`, `draft`, `record`, `plan`, `reference`) so adding a new role doesn't require new dashboard code — each role's outputs render through the same five views regardless of domain. See [output.md](output.md) for the full taxonomy spec.

Three page levels:

- **`/output`** — overview. Five type cards with counts and the most recent entry per type, plus a 10-entry recent-activity feed underneath.
- **`/output/[type]`** — listing for one type. Filter chips for status (drawn from the closed lifecycle enum: `draft`, `review`, `ready`, `sent`, `done`, `archived`); for records, an extra `entity_type` filter chip row.
- **`/output/[type]/[...slug]`** — detail. Dispatches to one of five per-type renderers based on the file's `type` frontmatter:

| Type | Renderer | What it shows |
|---|---|---|
| `document` | `DocumentView` | Title + status pill + audience meta + prose body |
| `draft` | `DraftView` | Envelope head (To / Via / Subject), body in a quoted inset, "Mark as sent" action that POSTs the status update |
| `record` | `RecordView` | Entity-prominent header (`entity_type · entity_id`), observed_at inline |
| `plan` | `PlanView` | Goal + owner + progress bar (parsed from `- [ ]` / `- [x]` count in the body) |
| `reference` | `ReferenceView` | Topic + tag pills + prose body |

The chat tools `write_output` and `update_output_status` write the same files this surface reads. Both commit through the audit module, so every output mutation appears in `git log` with the role's authorship.

## Audit trail

Every dashboard-mediated mutation — chat-side tool calls and operator-side triage actions — lands as a git commit on the role's repo. Two synthetic actors keep `git log --author=` filtering honest:

| Surface | Author | Conventional commit |
|---|---|---|
| `write_memory` (chat) | `Praxis Role <role@praxis.local>` | `role(memory): note <slug>` |
| `create_escalation` (chat) | `Praxis Role <role@praxis.local>` | `role(escalation): file <kind> — <slug>` |
| `propose_verb` (chat) | `Praxis Role <role@praxis.local>` | `role(verb): propose <slug>` |
| `log_decision` (chat) | `Praxis Role <role@praxis.local>` | `role(decision): log <decision_type>` |
| `append_entry` (chat) | `Praxis Role <role@praxis.local>` | `role(lib): append <surface>` |
| `enrich_entry` (chat) | `Praxis Role <role@praxis.local>` | `role(lib): enrich <surface>` |
| `adjust_param` (chat) | `Praxis Role <role@praxis.local>` | `role(lib): adjust <surface>:<key>` |
| `write_output` (chat) | `Praxis Role <role@praxis.local>` | `role(output): write <type> <slug>` |
| `update_output_status` (chat) | `Praxis Role <role@praxis.local>` | `role(output): status <slug>: <prev> → <next>` |
| `POST /api/output/.../{slug}` (dashboard) | operator (from `git config`) | `operator(output): status <slug>: <prev> → <next>` |
| accept / decline / comment escalation (triage) | operator (from `git config`) | `operator(triage): <action> escalation <id>` |
| accept / decline / edit proposed verb (triage) | operator (from `git config`) | `operator(triage): <action> proposed verb <slug>` |
| co-author apply (triage/draft) | operator (from `git config`) | `operator(<persona\|claude-md\|verb\|lib\|coauthor>): apply proposal for <summary> (#<escalation_id>)` with a `Co-Authored-By: Praxis Role` trailer in the body. Single-kind proposal sets use the kind as the scope; mixed-kind sets fall back to `coauthor`. |

The role's repo doesn't need to be a git repo on first launch — the audit module auto-initialises one and lays a `chore: praxis init audit baseline` commit before any mutation lands. If the operator hasn't set a git identity, operator-side commits fall back to `Operator <operator@praxis.local>` and the triage UI surfaces a soft banner inviting them to set `user.name`/`user.email`.

The audit-commit path is best-effort: any failure (no diff to commit, hook rejection, disk error) returns a warning to the caller but never blocks the primary mutation. Chat-side tool calls render the short SHA inline (`→ wrote memory/foo.md  abc1234`) on success or `(commit skipped: <reason>)` when the commit didn't land.

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
- **Phase 2 (chat)** (shipped): `/chat` ships the non-technical operator's conversational runtime; persona-as-system-prompt; persisted conversations under `memory/conversations/`; tool-use loop wired end-to-end with the typed toolset gated by `lib/autonomy.yaml` and `CONSTITUTIONAL_PATHS`.
- **Phase 4** (planned): verb-tag taxonomy from verb frontmatter, verbs grouped by tag in the dashboard

## What it isn't

- Not multi-role — one dashboard instance, one role. Multi-role = multiple framework clones.
- Not a search interface — feeds are linear. Use grep against the role-home for targeted lookups.
