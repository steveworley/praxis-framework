# Phase 2 — durable runtime spec (sketch)

**Status**: design sketch, not built. Captured 2026-05-08 from a discussion about moving praxis from Claude-Code-as-runtime to a durable deployment.

## Why

Today a praxis role runs as a Claude Code session: ephemeral, operator-invoked, dev-loop-shaped. The role's *state* persists (in `persona.md`, `verbs/`, `lib/`, `memory/`, `escalations/`, `campaigns/`), but the *agent* doesn't — it lives only as long as the session.

For some roles that's fine (BD with daily review cadences). For others (incident response, account watchers, anything with off-hours triggers) the role needs to be always-on: scheduled cron, event-driven webhooks, queue-driven tasks. Phase 2 is the durable runtime that supports those shapes.

## The frame

Praxis already separates **role spec** from **runtime**. The directory conventions, persona, verbs, lib, memory, escalations — those are the role spec. Claude Code is one runtime executor. Phase 2 builds another.

That separation is load-bearing for the framework's claim. The role spec doesn't change; the runtime is implementation detail. A durable runtime reads the same files, follows the same conventions, surfaces through the same dashboard.

## What changes about the framework

Surprisingly little, but three new primitives are needed:

### 1. Tool registry — verb frontmatter

Every verb file declares its required tool capabilities, trigger shape, and inputs/outputs in YAML frontmatter:

```yaml
---
verb: send-emails
when_to_run:
  type: stage_transition
  stage_in: [approved]
  requires: contact.pre_send.currency.status in [in_role, page_not_found]
inputs:
  - prospects:approved
  - lib/warmup.yaml
  - lib/compliance.yaml
outputs:
  - prospects:sent
tools:
  - bash
  - log
  - mcp:google-workspace
budget:
  max_tokens: 50000
  max_runtime_seconds: 600
---

# Email Sending Verb

You are Sam Parker. Your job is to send approved outreach emails via Gmail.
...
```

The runtime reads each verb file's frontmatter on startup, validates that all declared tools are available, and uses `when_to_run` to wire triggers.

### 2. Trigger config — `lib/triggers.yaml`

A central config declaring how verbs get invoked. Operator-authored, never edited by the role (gated, like `lib/autonomy.yaml`).

```yaml
# lib/triggers.yaml
# Operator-authored: declare when each agent fires.

triggers:
  # Cron-driven
  - verb: monitor-channels
    type: cron
    schedule: "*/15 * * * *"
    description: "Poll watched Slack channels every 15 minutes"

  # Stage-transition: fires when matching state lands
  - verb: draft-emails
    type: stage_transition
    when:
      stage_in: [contact_found, qualified]
    description: "Draft outreach when contacts are ready"

  - verb: pre-send-check
    type: stage_transition
    when:
      stage_in: [approved]
      missing: contact.pre_send.currency.status
    description: "Verify contact currency before send"

  - verb: send-emails
    type: stage_transition
    when:
      stage_in: [approved]
      requires: contact.pre_send.currency.status in [in_role, page_not_found]
    description: "Send approved + verified drafts"

  # Scheduled with day-of-week
  - verb: account-read
    type: cron
    schedule: "0 9 * * MON"
    description: "Weekly customer account read, Monday 9am AEST"

  # Event-driven (webhook or MCP signal)
  - verb: respond
    type: event
    source: mcp:gmail.reply_received
    description: "Handle warm replies as they land"

  # On-demand only — never auto-fires
  - verb: discover
    type: on_demand
    description: "Operator: 'run discover for {campaign}'"

  # Chained from another verb's output
  - verb: review
    type: chained
    after: draft-emails
    when:
      stage_in: [pending_review]
    description: "Auto-route drafts to review"
```

#### Trigger types

| Type | When it fires | Use case |
|---|---|---|
| `cron` | Standard cron schedule | Periodic polling, scheduled reads |
| `stage_transition` | A prospect/work-product hits a configured stage | Pipeline progression |
| `event` | Webhook, MCP signal, queue message | Reactive: replies, alerts, inbound |
| `on_demand` | Operator-invoked only | Manual control, debug |
| `chained` | Fires from another agent's output | Tight coupling between steps |

### 3. Tool surface contract — `template/lib/tools.yaml`

Framework-level catalog of capability strings. Roles declare needed tools per-verb (in frontmatter); the runtime maps capabilities to concrete adapters at startup.

```yaml
# template/lib/tools.yaml
# The capabilities a praxis-compatible runtime must provide. A role's agent
# files declare which of these they need; the runtime validates availability
# and refuses to invoke an agent whose tools aren't ready.

capabilities:
  bash:
    description: "Shell execution scoped to the role's working directory"
    sandbox: "role-isolated"
    always_available: true

  edit:
    description: "Read/write files inside the role's working directory"
    always_available: true

  websearch:
    description: "Web search via configured provider"
    provider_options: [tavily, brave, google]
    config_key: "websearch.provider"

  log:
    description: "praxis log structured JSONL logging — appends to campaigns/{id}/logs/{date}.jsonl"
    always_available: true

  mcp:google-workspace:
    description: "Gmail, Calendar, Drive"
    auth: "service-account or per-role oauth"
    config_key: "mcp.google_workspace.auth"

  mcp:slack:
    description: "Slack read/write"
    auth: "per-role token"
    config_key: "mcp.slack.token"

  mcp:playwright:
    description: "Headless browser for JS-rendered pages"
    sandbox: "role-isolated container"
```

Runtimes implement adapters for each capability. A role that declares `tools: [mcp:salesforce]` won't run on a runtime that doesn't have a Salesforce adapter — fast fail at startup beats partial fail at runtime.

## The runtime architecture

```
┌─────────────────────────────────────────┐
│  Praxis runtime container (per role)    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Role state (mounted volume)     │    │
│  │   verbs/    lib/   memory/      │    │
│  │   campaigns/   escalations/     │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Trigger router                  │    │
│  │   reads lib/triggers.yaml       │    │
│  │   schedules cron, watches       │    │
│  │   stages, subscribes to events  │    │
│  └────────────┬────────────────────┘    │
│               ▼                         │
│  ┌─────────────────────────────────┐    │
│  │ Anthropic API session           │    │
│  │   system: CLAUDE.md + persona   │    │
│  │   user: verb file body          │    │
│  │   tools: per-verb registry      │    │
│  │   working_dir: /role            │    │
│  └────────────┬────────────────────┘    │
│               ▼                         │
│  ┌─────────────────────────────────┐    │
│  │ Tool surface adapters           │    │
│  │   bash · edit · websearch       │    │
│  │   mcp adapters · log            │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Supervisor                      │    │
│  │   retries · deadlines · paging  │    │
│  │   per-task and per-day budgets  │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
        │                          ▲
        │ writes files             │ HiTM async
        ▼                          │
┌─────────────────────────────────────────┐
│  Praxis dashboard (separate process)    │
│  /escalations · /activity · /role · …   │
│  + live runs · intervention controls    │
└─────────────────────────────────────────┘
```

A role per container. Mounted volume for role state. The runtime reads triggers, fires verbs, the dashboard reads the files for visibility. The HiTM gate (escalations) is async — operator approves from the dashboard whenever they get to it, no live session required.

## What stays unchanged

Everything that's already in praxis:

- `persona.md` (role root) + `verbs/` (playbooks)
- `lib/` reference data
- `memory/` notebook
- `escalations/` queue
- `praxis log` JSONL logging
- Decisions primitive
- Autonomy model
- Reflection beat
- Two-commit seed
- The dashboard's read-side surfaces

The role spec is the contribution. The durable runtime is a *new executor* for that spec — not a rewrite of the spec.

## What's specifically new

| Primitive | Purpose | Notes |
|---|---|---|
| Verb frontmatter | Per-verb declaration of tools, triggers, inputs/outputs, budget | Migrate existing verbs — small effort |
| `lib/triggers.yaml` | Central trigger config | Operator-authored; gated like autonomy.yaml |
| `template/lib/tools.yaml` | Framework-level capability catalog | Versioned with the framework |
| Runtime container | Docker image with supervisor + tool adapters + Anthropic client | Phase 2 deliverable |
| Tool adapters | Bash sandbox, MCP wrappers, websearch, log | Per-capability work |
| Trigger router | Cron, stage watchers, event subscribers, on-demand entry point | Glue layer |
| Supervisor | Retries, deadlines, budgets, paging | Operational maturity |
| Dashboard durable-mode UI | Live runs, intervention controls, budget panel | Extension to existing dashboard |

## Migration path for Sam (or any existing role)

**Phase 1.5** (preparatory, low-risk):
- Add frontmatter to existing verb files declaring tools + when_to_run + budget
- Create `lib/triggers.yaml` describing how each verb currently fires (mostly `on_demand` for now)
- No runtime change yet — Sam still runs in Claude Code

**Phase 2.0** (parallel deployment):
- Stand up the runtime container against Sam's role home (read-only at first, dry-run mode)
- Verify the trigger router fires the right verbs at the right time without actually invoking
- Compare what *would* have happened against Sam's actual Claude Code runs

**Phase 2.1** (live durable):
- Switch primary runtime to the container
- Claude Code becomes the dev-loop / debugging surface
- Dashboard adds live-status pane showing active runs

## Open questions

- **Concurrency model.** Does the runtime process prospects in parallel, or serialize per pipeline? Sam's pipeline implicitly assumes serial; parallel breaks some sequencing. Probably need per-stage parallelism caps.
- **Working-dir mutation safety.** Two verbs writing to the same prospect file simultaneously is a race. File locking? Per-prospect mutex? Optimistic concurrency control (compare-and-swap on a version field)?
- **Reflection-beat trigger.** "End of run" is well-defined when an operator drives. For a long-running daemon, what's the unit-of-run? Per-task-cluster? Time-windowed? Per-verb-invocation?
- **Cost / budget management.** Per-agent budgets, per-day caps, alerting when budget exhausted. How does that surface to the operator?
- **Tool-availability degradation.** What happens when an MCP goes down mid-run? Per-tool fallback? Pause-the-role? Surface as escalation?
- **Multi-role on one host.** One role per container or many? Resource isolation? Shared MCPs?
- **Role identity in commits.** When the runtime makes an autonomous edit on the role's behalf, the git commit's `--author` is the role. The runtime needs role credentials configured per-deployment.

These get worked out during Phase 2 build, not before.

## Phase 2 work breakdown (proposed sub-issues)

1. **Spec: tool registry primitive** — define verb frontmatter schema; document; migrate `template/verbs/escalate.md` and the wizard's stub generator
2. **Spec: trigger config primitive** — define `lib/triggers.yaml` schema; document the five trigger types
3. **Spec: tool surface contract** — define `template/lib/tools.yaml` capability catalog; document
4. **Build: runtime container scaffold** — Dockerfile, mounted-volume role state, Anthropic API integration, trigger router skeleton
5. **Build: tool adapters** — bash sandbox, websearch, log, MCP wrappers (Google Workspace, Slack, Playwright)
6. **Build: supervisor & budget** — retries, deadlines, per-task and per-day token caps, paging integration
7. **Dashboard: durable-mode UI** — live runs pane, intervention controls (kill run, force trigger), budget consumption panel
8. **Migration: Sam** — frontmatter migration, dual-run period, switch primary
9. **Docs: deployment guide** — runtime config, MCP setup, scaling, security considerations

## What this is not

- Not a rewrite of the role spec. The directory conventions, persona, verbs, lib — all unchanged.
- Not Hermes. Even with a durable runtime, capability changes still go through the HiTM gate (`verbs/proposed/` + operator acceptance). The runtime fires verbs; it doesn't modify them.
- Not a replacement for Claude Code. Claude Code remains the dev-loop / debugging / interactive surface. The durable runtime is the production executor.
- Not a multi-tenant platform. One role per deployment. Multi-role = multiple deployments. (That separation is by design — see `docs/philosophy.md` on cross-role state.)
