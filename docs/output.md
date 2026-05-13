# Output

The framework ships a typed work-product surface at `output/` with five primitives. Each role's outputs render through the same framework-shipped views regardless of domain — adding a new role doesn't require new dashboard code.

The five primitives, chosen to span most knowledge-work outputs:

- **`document`** — long-form prose. A brief, a note, an analysis.
- **`draft`** — outgoing communication. An email, a Slack DM, a letter, a call note prepared in advance.
- **`record`** — observation tied to an entity. An account read, a meeting log, a contact note.
- **`plan`** — multi-step intent with a checklist body. The body's `- [ ]` / `- [x]` items drive a progress bar in the dashboard.
- **`reference`** — reusable knowledge worth keeping. A heuristic, a recipe, a calibration.

Each entry carries the same closed-enum status:

```
draft → review → ready → sent → done → archived
```

`draft` is the default for a freshly-written entry. The role flips it forward (or the operator does) via `update_output_status` / the dashboard's status controls. The enum is intentionally closed framework-wide — roles do not invent new statuses; if a state doesn't fit, file an `improvement` escalation.

## Paths

```
output/
├── document/<slug>.md
├── draft/<slug>.md
├── record/<entity_type>/<entity_id>/<slug>.md
├── plan/<slug>.md
└── reference/<slug>.md
```

Slug regex (and `entity_type` / `entity_id` for records): `/^[a-z0-9][a-z0-9-]*$/`. Lowercase letters and digits, hyphens allowed, must start alphanumeric. Path traversal sequences are refused at every entry point — the chat tool, the loader, and the API.

## Frontmatter

Every output file is a markdown document with YAML frontmatter and a body. The frontmatter fields are validated server-side via Zod (`dashboard/src/lib/output/types.ts`).

### Universal fields

All five types carry:

| Field | Notes |
|---|---|
| `type` | One of `document`, `draft`, `record`, `plan`, `reference` |
| `slug` | Matches the filename stem |
| `status` | One of `draft`, `review`, `ready`, `sent`, `done`, `archived` |
| `created` | Local ISO 8601 with timezone offset (`2026-05-13T09:14:22+10:00`) |
| `updated` | Same format. Bumped on every status change. |

### Per-type fields

**document** — required `title`; optional `audience`.

```markdown
---
type: document
slug: q1-shipping-plan
status: ready
title: Q1 shipping plan
audience: exec team
created: 2026-05-01T10:00:00+10:00
updated: 2026-05-02T11:00:00+10:00
---

# Q1 shipping plan

Three milestones, two contingencies, one date that matters.
```

**draft** — required `none`; optional `recipient`, `channel`, `subject`. `channel` is a closed enum: `email | slack | dm | letter | call | other`.

```markdown
---
type: draft
slug: cold-mary-acme
status: draft
recipient: mary@acme.com
channel: email
subject: 'Quick question for you'
created: 2026-05-13T08:00:00+10:00
updated: 2026-05-13T08:00:00+10:00
---

Hi Mary,

Saw your team's announcement about the warehouse expansion. We've been
helping a few logistics teams with the same shape of problem — would you
be open to a 15-minute call next week?

Sam
```

**record** — required `entity_type`, `entity_id`, `observed_at`. The entity segments drive the on-disk path: every record about the same entity sits in the same directory.

```markdown
---
type: record
slug: 2026-q1-read
status: done
entity_type: account
entity_id: acme
observed_at: 2026-04-28
created: 2026-04-28T15:00:00+10:00
updated: 2026-04-28T15:00:00+10:00
---

Q1 read on Acme. Renewal in October, expansion conversation softer than
last quarter — Mary has new priorities since the leadership change.
```

**plan** — required `goal`; optional `owner`. Body is a checklist; the dashboard parses `- [ ]` / `- [x]` lines to compute progress.

```markdown
---
type: plan
slug: land-acme-q3
status: draft
goal: 'Land Acme expansion deal by Q3'
owner: sam
created: 2026-05-10T09:00:00+10:00
updated: 2026-05-10T09:00:00+10:00
---

- [x] Intro call with Mary
- [ ] Pricing alignment with finance
- [ ] Demo for the new warehouse team
- [ ] Decision meeting with leadership
```

**reference** — required `topic`; optional `tags` (string array).

```markdown
---
type: reference
slug: pricing-objection-patterns
status: ready
topic: pricing objection patterns
tags: [pricing, objections, sales]
created: 2026-03-01T12:00:00+10:00
updated: 2026-03-01T12:00:00+10:00
---

Two patterns we see most often, and the moves that work for each.

## Pattern 1: anchoring on legacy pricing
...
```

## Tools

The chat surface exposes two output tools:

- **`write_output`** — creates a new file. Validates type / slug / status / required fields, resolves the path via the registry, refuses if the file already exists.
- **`update_output_status`** — flips an existing file's `status` to a new value from the closed enum. Refuses if the file doesn't exist.

Both commit via the audit module: `role(output): write <type> <slug>` and `role(output): status <slug>: <prev> → <next>`. From the dashboard side, the operator's status updates land as `operator(output): status <slug>: <prev> → <next>`.

## Dashboard rendering

`/output` is the operator-facing surface, with three levels:

- **`/output`** — overview. Five type cards (counts + most recent entry) plus a 10-row recent-activity feed.
- **`/output/[type]`** — listing per type. Filter chips for status; for records, an additional `entity_type` chip row.
- **`/output/[type]/[...slug]`** — detail, dispatching to one of five per-type Astro components in `dashboard/src/components/output/`:

| Type | Renderer | Layout |
|---|---|---|
| `document` | `DocumentView.astro` | Title + status pill + audience meta + prose body |
| `draft` | `DraftView.astro` | Email envelope (To / Via / Subject), body in a quoted inset, "Mark as sent" action |
| `record` | `RecordView.astro` | Entity-prominent header (`entity_type · entity_id`), observed_at, body |
| `plan` | `PlanView.astro` | Goal + owner + progress bar (parsed from checklist), markdown body |
| `reference` | `ReferenceView.astro` | Topic + tag pills + body |

The "Mark as sent" action on drafts hits the same status endpoint the chat tool does — it's operator-attributed (commits as the operator) but writes the exact same file shape. The dashboard does NOT send anything — drafts living on disk are records that the operator intends to send, or has sent. The framework's job is to capture the intent and the lifecycle, not to deliver.

## What's not in this taxonomy

- **Role-defined types.** The framework ships five primitives and stops. If a role's work product genuinely doesn't fit, the role can keep using a bespoke work-product directory (Sam's `campaigns/` is the reference case). Role-defined taxonomy is a follow-up — the framework currently doesn't merge a role's schemas with the five framework-shipped ones.
- **Send infrastructure.** No tool actually sends an email or posts a Slack message. Drafts are recorded intent; delivery is the operator's job.
- **Kanban / board views for plans.** Plans show a progress bar derived from the checklist. A full board view is a follow-up.
- **Full-text search across outputs.** Out of scope for v1 — grep against the role-home is fine.
- **Cross-references between outputs.** A draft doesn't yet know it's "for" a plan or "about" a record. Adding cross-refs is a follow-up.

## Authoritative schema location

The runtime registry lives in TypeScript at `dashboard/src/lib/output/types.ts` — that's the source of truth read by the chat tools, the loader, the API routes, and the dashboard renderers. The same shape is mirrored as operator-facing reference at `lib/output-schemas.yaml` in the seeded role home; that YAML is for reading, not parsing — editing it does not change runtime behaviour.
