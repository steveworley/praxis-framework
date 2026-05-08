# Phase 2 — durable runtime spec (sketch)

**Status**: design sketch, not built. Captured 2026-05-08 from a discussion about moving praxis from Claude-Code-as-runtime to a durable deployment. Updated 2026-05-08 with deployment topology, CLI setup, and tool-transport primitives.

## Phasing

The Phase 2 work splits cleanly into two stages, each shippable on its own:

- **Phase 1.5 — Deployment surface** (CLI + Docker Compose). Replaces the dashboard wizard with a Node CLI that walks through role setup and outputs a configured praxis repo + `docker-compose.yml` ready to run. The compose stack defines services (dashboard, runtime, MCPs, supervisor) but most of them are stub services until Phase 2.0. **Useful on its own** — operators get reproducible setup, version-controlled deployment config, and a path off the "open Claude Code in this directory" model. Doesn't require the durable runtime to exist.
- **Phase 2.0 — Durable runtime**. Fills in the runtime container (Anthropic API session + tool adapters + supervisor + trigger router). The compose stack from 1.5 stays the same shape; the runtime service goes from stub to real.
- **Phase 2.1 — Production polish**. Multi-role tooling, observability, budget UX, MCP transport variants (URL-hosted in addition to stdio).

The rest of this doc describes the end state. Section markers below note which phase each piece belongs to.

## Why

Today a praxis role runs as a Claude Code session: ephemeral, operator-invoked, dev-loop-shaped. The role's *state* persists (in `agents/`, `lib/`, `memory/`, `escalations/`, `campaigns/`), but the *agent* doesn't — it lives only as long as the session.

For some roles that's fine (BD with daily review cadences). For others (incident response, account watchers, anything with off-hours triggers) the role needs to be always-on: scheduled cron, event-driven webhooks, queue-driven tasks. Phase 2 is the durable runtime that supports those shapes.

## The frame

Praxis already separates **role spec** from **runtime**. The directory conventions, persona, agents, lib, memory, escalations — those are the role spec. Claude Code is one runtime executor. Phase 2 builds another.

That separation is load-bearing for the framework's claim. The role spec doesn't change; the runtime is implementation detail. A durable runtime reads the same files, follows the same conventions, surfaces through the same dashboard.

## What changes about the framework

Surprisingly little, but three new primitives are needed:

### 1. Tool registry — agent frontmatter

Every agent file declares its required tool capabilities, trigger shape, and inputs/outputs in YAML frontmatter:

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

# Email Sending Agent

You are Sam Parker. Your job is to send approved outreach emails via Gmail.
...
```

The runtime reads each agent file's frontmatter on startup, validates that all declared tools are available, and uses `when_to_run` to wire triggers.

### 2. Trigger config — `lib/triggers.yaml`

A central config declaring how agents get invoked. Operator-authored, never edited by the agent (gated, like `lib/autonomy.yaml`).

```yaml
# lib/triggers.yaml
# Operator-authored: declare when each agent fires.

triggers:
  # Cron-driven
  - agent: monitor-channels
    type: cron
    schedule: "*/15 * * * *"
    description: "Poll watched Slack channels every 15 minutes"

  # Stage-transition: fires when matching state lands
  - agent: draft-emails
    type: stage_transition
    when:
      stage_in: [contact_found, qualified]
    description: "Draft outreach when contacts are ready"

  - agent: pre-send-check
    type: stage_transition
    when:
      stage_in: [approved]
      missing: contact.pre_send.currency.status
    description: "Verify contact currency before send"

  - agent: send-emails
    type: stage_transition
    when:
      stage_in: [approved]
      requires: contact.pre_send.currency.status in [in_role, page_not_found]
    description: "Send approved + verified drafts"

  # Scheduled with day-of-week
  - agent: account-read
    type: cron
    schedule: "0 9 * * MON"
    description: "Weekly customer account read, Monday 9am AEST"

  # Event-driven (webhook or MCP signal)
  - agent: respond
    type: event
    source: mcp:gmail.reply_received
    description: "Handle warm replies as they land"

  # On-demand only — never auto-fires
  - agent: discover
    type: on_demand
    description: "Operator: 'run discover for {campaign}'"

  # Chained from another agent's output
  - agent: review
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

Framework-level catalog of capability strings. Roles declare needed tools per-agent (in frontmatter); the runtime maps capabilities to concrete adapters at startup. Each capability declares supported transports — making the framework runtime-agnostic about *where* a tool runs.

```yaml
# template/lib/tools.yaml
# The capabilities a praxis-compatible runtime must provide. A role's agent
# files declare which of these they need; the runtime validates availability
# and refuses to invoke an agent whose tools aren't ready.

capabilities:
  bash:
    description: "Shell execution scoped to the role's working directory"
    transport: native        # in-process to the runtime
    sandbox: "role-isolated"
    always_available: true

  edit:
    description: "Read/write files inside the role's working directory"
    transport: native
    always_available: true

  websearch:
    description: "Web search via configured provider"
    transport: url           # HTTP API call
    provider_options: [tavily, brave, google]

  log:
    description: "bin/log structured JSONL logging"
    transport: native
    always_available: true

  mcp:google-workspace:
    description: "Gmail, Calendar, Drive via MCP"
    transport_options: [stdio, sse, url]   # configurable per deployment
    auth: "oauth token in env"

  mcp:slack:
    description: "Slack read/write via MCP"
    transport_options: [stdio, sse, url]
    auth: "bot token in env"

  mcp:playwright:
    description: "Headless browser for JS-rendered pages via MCP"
    transport_options: [stdio, sse]        # url-hosted Playwright is harder
```

Roles configure the transport per deployment in `lib/role-config.yaml` (or `.env`):

```yaml
# lib/role-config.yaml — operator-authored deployment config
tools:
  mcp:google-workspace:
    transport: stdio
    command: ["docker", "exec", "mcp-google-workspace", "stdio-bridge"]
    # OR for hosted/remote:
    # transport: url
    # url: "https://mcp.example.com/google-workspace"
    # auth_header_env: "GOOGLE_WORKSPACE_TOKEN"

  mcp:slack:
    transport: url           # hosted MCP
    url: "https://mcp.quantcdn.io/slack"
    auth_header_env: "SLACK_MCP_TOKEN"
```

The `url` transport in particular is the framework's escape hatch for hosted MCPs — operators can mix locally-containerized adapters (cheap, full control) with remote-hosted ones (managed, no per-deployment OAuth flow) without changing the role spec. This matters as third-party hosted MCPs proliferate.

Runtimes implement adapters for each transport. A role that declares `tools: [mcp:salesforce]` won't run on a runtime that has no Salesforce adapter configured — fast fail at startup beats partial fail at runtime.

## Deployment topology — Docker Compose (Phase 1.5)

The chosen single-host deployment topology for praxis is **Docker Compose**. The dashboard repo already uses it (`docker-compose.yml` exists for the Phase 1 dev experience); Phase 1.5 grows it into the canonical deployment surface for the full stack.

### Why compose

- **Single command** to bring up an entire role: `docker compose up`
- **Service topology becomes declarative** — runtime, dashboard, MCPs, supervisor are services in YAML, not custom orchestration
- **Internal service-DNS** (e.g. `http://mcp-google-workspace:3000`) replaces port juggling
- **Volumes** declared once, mounted into multiple services (runtime read-write, dashboard read-only)
- **Multi-role** = duplicate the runtime service block per role, or stand up a second compose project
- **Local-first parity** — same compose file runs on a laptop and a single-host VM, with env-specific overrides
- **Health checks + dependency ordering** — declarative, no custom supervision plumbing for basic restart-on-failure

### Example shape

```yaml
# docker-compose.yml
services:
  runtime-{role}:
    image: praxis/runtime:latest
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      ROLE_HOME: /role
      ROLE_NAME: "{Full Name}"
      ROLE_EMAIL: "{role-email}"
    volumes:
      - {role}-state:/role
    depends_on:
      mcp-google-workspace: { condition: service_healthy }
      mcp-slack:            { condition: service_healthy }
    restart: unless-stopped

  mcp-google-workspace:
    image: praxis/mcp-google-workspace:latest
    env_file: ./secrets/google-workspace.env
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:3000/health"] }
    restart: unless-stopped

  mcp-slack:
    image: praxis/mcp-slack:latest
    env_file: ./secrets/slack.env
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:3000/health"] }
    restart: unless-stopped

  dashboard:
    build: ./dashboard
    ports: ["4321:4321"]
    volumes:
      - {role}-state:/roles/{role}:ro
    environment:
      PRAXIS_ROLES: '[{"name":"{role}","home":"/roles/{role}"}]'

volumes:
  {role}-state:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ${ROLE_HOME}
```

Adding a second role = ~5 more lines (a runtime service block + volume entry).

### What compose isn't

- **Not multi-host.** Single-host is the v1 target. Operators running 1-10 roles per machine are well-served. K8s comes later if praxis ever needs to scale to fleets.
- **Not a secrets manager.** `.env` per service for v1; vault integration is a Phase 2.1 expansion.
- **Not a backup primitive.** Volumes are bind-mounted to known host paths; backups are a separate operational concern.

## Setup moves to a CLI (Phase 1.5)

Today setup is the dashboard wizard at `/setup` — Astro + Alpine, lives inside the dashboard service. That model has a chicken-and-egg: to set up the role, you have to run the dashboard; to run the dashboard, you have to deploy the compose stack. Awkward for first-time operators.

Phase 1.5 replaces the dashboard wizard with a Node CLI: `npx praxis init` walks through the same flow, outputs a configured praxis repo + `docker-compose.yml` + `.env.example`. Operators run `docker compose up` after setup, never before.

### Why CLI over web UI

- **Unix idiom** — matches `npx create-next-app`, `npm init`, `cargo new`. Operators expect setup to be a CLI.
- **Composable** — scriptable, automatable, runnable in CI for role provisioning.
- **No chicken-and-egg** — setup doesn't require the deployment stack to be running.
- **Output is committable** — the configured repo + compose file go straight into source control, which is the right artifact for production deployment.
- **Cleaner separation of concerns** — dashboard becomes pure runtime surface (read + intervene), not also the bootstrap.

### CLI shape (sketch)

```
$ npx praxis init my-role
? Organisation name: Quant
? Website: https://quantcdn.io
? Sector: CDN / hosting / edge
? Org size: small
? Brief description (1-3 sentences): ...
? Known moats (optional): ...
? Customer profile: ...
?
? Role name: Sam Parker
? Working title: BD agent
? One-sentence purpose: Owns sales-side outreach for Quant.
? Day-to-day (optional): ...
?
? Setup path:
  ❯ Research and design it for me (writes a brief, hands off to claude)
    Define it yourself

? Voice traits (1-8): ...
? Capabilities: ...
? Hard inhibitions: ...
? Initial agents (0-5): ...
?
? Tools needed (multi-select from catalog):
  ◉ bash (always available)
  ◉ edit (always available)
  ◉ log (always available)
  ◉ websearch
  ◉ mcp:google-workspace
  ◉ mcp:slack
  ◯ mcp:playwright
  ◯ mcp:salesforce
?
? Triggers (sensible defaults pre-filled):
  ✓ on_demand for all agents (refine in lib/triggers.yaml later)

✓ Wrote: agents/, lib/, memory/, escalations/
✓ Wrote: docker-compose.yml (1 role, 3 MCPs, dashboard)
✓ Wrote: .env.example (ANTHROPIC_API_KEY, GOOGLE_WORKSPACE_TOKEN, SLACK_BOT_TOKEN)
✓ Wrote: README.md

Next:
  cp .env.example .env && $EDITOR .env       # fill in your secrets
  docker compose up                           # start the stack
  open http://localhost:4321/                 # dashboard
```

Other CLI subcommands:

- `praxis tools list` — show capabilities catalog from `template/lib/tools.yaml`
- `praxis triggers add` — interactive: add a trigger entry to `lib/triggers.yaml`
- `praxis lint` — validate role frontmatter against tools availability
- `praxis seed --research-only` — write the research-brief.md and exit (operator runs claude separately, then `praxis seed --from-draft`)

### What happens to the existing dashboard wizard

The dashboard wizard at `dashboard/src/pages/setup.astro` + `SetupWizard.astro` becomes secondary. Two options:

1. **Remove it** — CLI is the only setup path. Cleanest.
2. **Keep it** as a "convenience wizard" for laptop dev loop, sharing the underlying seed-role logic with the CLI.

Recommendation: option 1 for v1. The wizard was a useful stepping stone; once the CLI exists and the compose stack is the deployment surface, the wizard's purpose is gone.

The seed logic (`dashboard/src/lib/seed-role.ts`, `research-engine.ts`) extracts into a shared package the CLI consumes:

```
@praxis/seed         # the seed-role logic, runtime-agnostic
@praxis/cli          # the CLI tool, depends on @praxis/seed
@praxis/dashboard    # the dashboard, also depends on @praxis/seed for the editable-review surface
```

## The runtime architecture

```
┌─────────────────────────────────────────┐
│  Praxis runtime container (per role)    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Role state (mounted volume)     │    │
│  │   agents/   lib/   memory/      │    │
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
│  │   user: agent file body         │    │
│  │   tools: per-agent registry     │    │
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

A role per container. Mounted volume for role state. The runtime reads triggers, fires agents, the dashboard reads the files for visibility. The HiTM gate (escalations) is async — operator approves from the dashboard whenever they get to it, no live session required.

## What stays unchanged

Everything that's already in praxis:

- `agents/` directory + persona + playbooks
- `lib/` reference data
- `memory/` notebook
- `escalations/` queue
- `bin/log` JSONL logging
- Decisions primitive
- Autonomy model
- Reflection beat
- Two-commit seed
- The dashboard's read-side surfaces

The role spec is the contribution. The durable runtime is a *new executor* for that spec — not a rewrite of the spec.

## What's specifically new

| Primitive | Purpose | Notes |
|---|---|---|
| Agent frontmatter | Per-agent declaration of tools, triggers, inputs/outputs, budget | Migrate existing agents — small effort |
| `lib/triggers.yaml` | Central trigger config | Operator-authored; gated like autonomy.yaml |
| `template/lib/tools.yaml` | Framework-level capability catalog | Versioned with the framework |
| Runtime container | Docker image with supervisor + tool adapters + Anthropic client | Phase 2 deliverable |
| Tool adapters | Bash sandbox, MCP wrappers, websearch, log | Per-capability work |
| Trigger router | Cron, stage watchers, event subscribers, on-demand entry point | Glue layer |
| Supervisor | Retries, deadlines, budgets, paging | Operational maturity |
| Dashboard durable-mode UI | Live runs, intervention controls, budget panel | Extension to existing dashboard |

## Migration path for Sam (or any existing role)

**Phase 1.5** (preparatory, low-risk):
- Add frontmatter to existing agent files declaring tools + when_to_run + budget
- Create `lib/triggers.yaml` describing how each agent currently fires (mostly `on_demand` for now)
- No runtime change yet — Sam still runs in Claude Code

**Phase 2.0** (parallel deployment):
- Stand up the runtime container against Sam's role home (read-only at first, dry-run mode)
- Verify the trigger router fires the right agents at the right time without actually invoking
- Compare what *would* have happened against Sam's actual Claude Code runs

**Phase 2.1** (live durable):
- Switch primary runtime to the container
- Claude Code becomes the dev-loop / debugging surface
- Dashboard adds live-status pane showing active runs

## Open questions

- **Concurrency model.** Does the runtime process prospects in parallel, or serialize per pipeline? Sam's pipeline implicitly assumes serial; parallel breaks some sequencing. Probably need per-stage parallelism caps.
- **Working-dir mutation safety.** Two agents writing to the same prospect file simultaneously is a race. File locking? Per-prospect mutex? Optimistic concurrency control (compare-and-swap on a version field)?
- **Reflection-beat trigger.** "End of run" is well-defined when an operator drives. For a long-running daemon, what's the unit-of-run? Per-task-cluster? Time-windowed? Per-agent-invocation?
- **Cost / budget management.** Per-agent budgets, per-day caps, alerting when budget exhausted. How does that surface to the operator?
- **Tool-availability degradation.** What happens when an MCP goes down mid-run? Per-tool fallback? Pause-the-role? Surface as escalation?
- **Multi-role on one host.** One role per container or many? Resource isolation? Shared MCPs?
- **Role identity in commits.** When the runtime makes an autonomous edit on the role's behalf, the git commit's `--author` is the role. The runtime needs role credentials configured per-deployment.

These get worked out during Phase 2 build, not before.

## Work breakdown by phase (proposed sub-issues)

### Phase 1.5 — Deployment surface (CLI + Compose)

Useful on its own; doesn't require the durable runtime to exist.

1. **Extract seed logic** to a shared package (`@praxis/seed`). Currently lives in `dashboard/src/lib/seed-role.ts`. Make it runtime-agnostic so both the CLI and the (eventual) dashboard can consume it.
2. **CLI tool** (`@praxis/cli`, `npx praxis init`) — interactive prompts mirroring the existing wizard, plus tool selection and trigger pre-fill. Output: configured role repo + `docker-compose.yml` + `.env.example`.
3. **Compose stack scaffold** — canonical `docker-compose.yml` template generated by `praxis init`. Services for runtime (stub for now), MCPs (configurable list), dashboard. Health checks and dependency ordering.
4. **Spec: tool registry primitive** — define agent frontmatter schema; migrate `template/agents/*.md` and the wizard's stub generator. Add the catalog at `template/lib/tools.yaml` with transport options.
5. **Spec: trigger config primitive** — `lib/triggers.yaml` schema; document the five trigger types. Pre-filled by CLI with `on_demand` defaults.
6. **Remove dashboard wizard** — once CLI is the canonical setup path, retire the `/setup` route and SetupWizard component. Dashboard becomes pure runtime surface.
7. **Docs: deployment guide (compose)** — clone, run CLI, edit `.env`, `docker compose up`. The five-minute setup story.

### Phase 2.0 — Durable runtime

The compose stack from 1.5 becomes load-bearing. Runtime services go from stub to real.

8. **Build: runtime container** — Dockerfile, Anthropic API session, trigger router (cron, stage_transition, event, on_demand, chained). The runtime image populates the `runtime-{role}` service in the compose stack.
9. **Build: tool adapters** — implementations for each transport (native, stdio, sse, url). Per-MCP container images for stdio/sse adapters. URL-transport tools use simple HTTP clients.
10. **Build: supervisor & budget** — retries, deadlines, per-task and per-day token caps, paging integration.
11. **Dashboard: durable-mode UI** — live runs pane, intervention controls (kill run, force trigger), budget consumption panel.
12. **Migration: Sam** — frontmatter migration on her existing agents, dual-run period (Claude Code + runtime container against same role home), switch primary runtime to container.

### Phase 2.1 — Production polish

13. **MCP transport variants** — beyond stdio: SSE and URL-hosted MCPs (mix-and-match per deployment).
14. **Multi-role tooling** — `praxis init --add-role-to existing-deployment`, shared MCP services across roles.
15. **Observability** — log aggregation, metrics, decision-rate dashboards.
16. **Secrets management** — vault integration as an alternative to `.env`.

## What this is not

- Not a rewrite of the role spec. The directory conventions, persona, agents, lib — all unchanged.
- Not Hermes. Even with a durable runtime, capability changes still go through the HiTM gate (`agents/proposed/` + operator acceptance). The runtime fires agents; it doesn't modify them.
- Not a replacement for Claude Code. Claude Code remains the dev-loop / debugging / interactive surface. The durable runtime is the production executor.
- Not a multi-tenant platform. One role per deployment. Multi-role = multiple deployments. (That separation is by design — see `docs/philosophy.md` on cross-role state.)
