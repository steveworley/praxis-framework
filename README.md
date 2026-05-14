<p>
  <img src="docs/assets/praxis-logo.png" alt="Praxis" width="360" />
</p>

_role-based agents that fit your business_

---

A framework for **role-based agents that grow within a defined role**. You author the role's constitution — voice, hard rules, capabilities, reference data. The role grows within bounds you declare, every change lands as a git commit attributed to either the role or the operator, and the supervisor reads the role's interior like a manager reviewing a direct report's working files.

The role is the unit of evolution, not the agent. See [`docs/philosophy.md`](docs/philosophy.md) for the framing, [`docs/comparison.md`](docs/comparison.md) for how praxis differs from self-improving (Hermes-class) agents.

## Bounded, audited self-improvement

Praxis is not a no-autonomy framework — it's a *differentiated* one. Different surfaces have different risk profiles, and `lib/autonomy.yaml` names which surfaces the role can edit directly and how.

| Surface | What the role can do | How |
|---|---|---|
| `memory/`, `escalations/`, `logs/`, `output/` | Write freely | Implicit `full` autonomy — these are the role's own working surfaces |
| `verbs/proposed/` | Draft new verbs | Drafts land here freely, but only become live `verbs/*.md` after operator acceptance via `/triage` |
| Operator-opened lists (e.g. `lib/research-strategies.yaml`) | Append new entries up to `max_pending` | `append-only` mode |
| Operator-owned structured entries (e.g. `lib/team.yaml`) | Update declared soft fields on existing entries | `inline-enrichment` mode |
| Operator-set parameter bands (e.g. `lib/warmup.yaml`) | Tune within `{min, max, step}` per key | `bounded` mode |
| `persona.md`, live `verbs/*.md`, `CLAUDE.md`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, `lib/tools.yaml` | Nothing autonomously | `gated` — hard-coded in `CONSTITUTIONAL_PATHS` regardless of yaml |

The constitution stays explicit. The growth stays visible. See [`docs/autonomy.md`](docs/autonomy.md) for the full model.

## Every change is a git commit

Dashboard-mediated mutations use two synthetic authors so `git log --author=` stays clean:

- `Praxis Role <role@praxis.local>` — autonomous chat-side writes. Subjects like `role(memory): note <slug>`, `role(escalation): file improvement — <slug>`, `role(lib): adjust warmup:sends_per_day`.
- The operator's own git identity — triage actions and co-authored applies. Subjects like `operator(triage): accept proposed verb <slug>` or `operator(persona): apply proposal for <summary>` with a `Co-Authored-By: Praxis Role` trailer.

`git revert <sha>` rolls back any autonomous edit. The worst-case mutation is one markdown entry on one known path. Bad-shape edits that keep getting reverted are signal — downgrade the surface in `lib/autonomy.yaml`.

## Directory shape

A praxis role lives in one directory:

- **`persona.md`** (role root) — identity, voice, capabilities, hard inhibitions. The role's constitution.
- **`CLAUDE.md`** (role root) — operating manual the runtime reads on session start.
- **`verbs/`** — modular markdown playbooks. One file per repeatable behavior. New drafts land in `verbs/proposed/` and are accepted via the dashboard's triage surface.
- **`lib/`** — declarative reference data. Role-authored, verb-readable. `lib/autonomy.yaml` declares which files are operator-opened and in which mode.
- **`memory/`** — observational notebook. Persona-shaped, longitudinal, free-form markdown. The role decides relevance. `memory/conversations/` holds chat transcripts.
- **`escalations/`** — structured asks (`help` / `improvement` / `proposed_skill` / `criterion_drift`). The role files; the operator triages.
- **`output/`** — typed work product. Five framework-shipped primitives (`document`, `draft`, `record`, `plan`, `reference`) with a closed-enum status lifecycle. See [`docs/output.md`](docs/output.md).
- **`logs/`** — JSONL decision feed. Optional per-work-product nested logs are also picked up by the dashboard's activity glob.

See [`docs/architecture.md`](docs/architecture.md) for the full layout.

## Quickstart

```bash
mkdir my-role && cd my-role
npx @praxis-framework/cli@latest init      # interactive wizard
cp .env.example .env && vim .env           # set ANTHROPIC_API_KEY
docker compose up                          # pulls the published dashboard image
```

That's it. The CLI walks you through identity, voice, capabilities, hard inhibitions, and optional starter verbs. It writes role files plus a `docker-compose.yml` and `.env.example` so the role is runnable with one `docker compose up` — no framework clone required. The seed auto-initialises the directory as a git repo on `main`.

Open `http://localhost:4321/`. The dashboard is your primary surface — `/chat` to operate the role, `/triage` to review what it raises, `/role` to inspect the constitution. See [`docs/dashboard.md`](docs/dashboard.md).

### Scripted setup

For CI or version-controlled role definitions:

```bash
mkdir my-role && cd my-role
npx @praxis-framework/cli@latest init --config ./role.json --path .
```

Sample config at [`cli/examples/sample-role.json`](cli/examples/sample-role.json). The CLI also ships `praxis log` for appending JSONL decision lines from inside verb playbooks — see [`cli/README.md`](cli/README.md).

### Alternative: seed via the dashboard wizard

If you'd rather seed by clicking through a browser form instead of the CLI's terminal prompts:

```bash
mkdir my-role && cd my-role
docker run --rm -p 4321:4321 \
  -v $(pwd):/role \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  ghcr.io/steveworley/praxis-framework/dashboard:latest
```

Same outputs as the CLI — `/setup` writes role files + `docker-compose.yml` + `.env.example` into the mounted directory as two visible commits. Useful if you don't have Node.js handy.

### Framework development

If you're contributing to praxis-framework itself (not seeding a role to operate):

```bash
git clone https://github.com/steveworley/praxis-framework.git
cd praxis-framework
docker compose up    # bind-mounts source for HMR via the dev Dockerfile
```

## Runtime

**The dashboard is the primary runtime.** Open `http://localhost:4321/chat` and talk to the role — the model is fed the role's interior as a system prompt (persona body, live verbs, hard rules, autonomy stance, tool catalog). Tool use is enabled, gated by `lib/autonomy.yaml` + `CONSTITUTIONAL_PATHS`. Conversations persist as markdown under `memory/conversations/`. Every change the role makes is a git commit, visible in `/role`'s recent-edits panel.

The chat surface exposes thirteen typed tools, grouped by intent:

- **Growth** — `write_memory`, `archive_memory`, `consolidate_memory`, `create_escalation`, `propose_verb`, `log_decision`, `run_verb`, `complete_verb`. The role's observational + verb-invocation surfaces.
- **Lib surgery** — `append_entry`, `enrich_entry`, `adjust_param`. Operator-opened YAML under the modes declared in `lib/autonomy.yaml`.
- **Work product** — `write_output`, `update_output_status`. The framework's typed `output/` taxonomy.

Constitutional surfaces stay gated regardless of yaml. The chat is never the place to mutate the role's constitution — that's what `/triage/draft/<id>` co-authoring is for (operator-driven, model-assisted).

**Claude Code on the host** is supported for maintenance work — editing `persona.md` and live verbs, refining `lib/`, debugging the role's directory directly. `cd /path/to/role && claude` gives full file and shell access. Use it when you need to touch the role's bones; for everyday operation, drive the role through the dashboard.

See [`docs/creating-a-role.md`](docs/creating-a-role.md) for the bootstrap walkthrough.

## The dashboard surfaces

| Route | Purpose |
|---|---|
| `/setup` | Wizard (alternative to the CLI). Refuses to run again on a populated role. |
| `/role` | Persona, verbs, autonomy stance, reference data, recent role-authored commits |
| `/chat` | Conversational runtime with the named persona. Manual reflect button, persisted threads, tool-use loop end-to-end. |
| `/triage` | Operator review for the role's raise-your-hand outputs — accept / decline / comment escalations, accept / edit / decline proposed verbs |
| `/triage/draft/[id]` | Operator-driven co-authoring of constitutional changes. Model drafts, operator reviews diffs and applies as one commit with a `Co-Authored-By: Praxis Role` trailer. |
| `/escalations` | Read-only browse of the escalation queue |
| `/notebook` | Memory entries, recency-sorted, filterable by category |
| `/output` | Typed work product — five primitives, status lifecycle, per-type renderers |
| `/output/[type]/[...slug]` | One entry, dispatched to `DocumentView` / `DraftView` / `RecordView` / `PlanView` / `ReferenceView` |
| `/activity` | JSONL decision feed across all log paths matching `PRAXIS_LOG_GLOB` |
| `/verbs/[slug]` | Verb detail — frontmatter, body, recent activity |

See [`docs/dashboard.md`](docs/dashboard.md) for the API surface, config, and audit-trail details. See [`docs/escalations.md`](docs/escalations.md) and [`docs/verbs.md`](docs/verbs.md) for the file-shape specs.

## Reference roles

Praxis is the conventions; the reference roles inhabit them. [`examples/README.md`](examples/README.md) describes Sam Parker, Quant's BD agent — the role praxis was originally extracted from. Sam's implementation lives at [`quantcdn/sam`](https://github.com/quantcdn/sam) (private repo); the framework keeps only the shape, not the content.

A planned second role (a CSM agent, working name Caro) is sketched in [`docs/future/caro-second-role.md`](docs/future/caro-second-role.md) — a test of whether the primitives generalise from episodic BD work to durative account work.

## Out of scope

Multi-agent orchestration (one role per directory), cross-role learning (no shared memory pool), full-text search (grep against the role-home), and any LLM-provider lock-in (Claude Code uses whatever it runs; `/chat` uses the Anthropic SDK and is configurable per-deploy).

## Deeper reading

- [`docs/philosophy.md`](docs/philosophy.md) — role-based growth, the four conventions, why directories instead of abstractions
- [`docs/comparison.md`](docs/comparison.md) — praxis vs self-improving agents, where each one fits, the trade-offs
- [`docs/autonomy.md`](docs/autonomy.md) — the four autonomy modes, the three guarantees, the co-authoring path
- [`docs/architecture.md`](docs/architecture.md) — directory shape, file formats, the role-runtime boundary
- [`docs/creating-a-role.md`](docs/creating-a-role.md) — bootstrap walkthrough
- [`docs/dashboard.md`](docs/dashboard.md) — surfaces, API, audit trail
- [`docs/output.md`](docs/output.md) — the typed work-product taxonomy
- [`docs/escalations.md`](docs/escalations.md), [`docs/verbs.md`](docs/verbs.md) — file-shape specs

## License

MIT.
