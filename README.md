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
- **`escalations/`** — structured asks (`help` / `improvement` / `proposed_skill`). The role files; the operator triages.
- **`output/`** — typed work product. Five framework-shipped primitives (`document`, `draft`, `record`, `plan`, `reference`) with a closed-enum status lifecycle. See [`docs/output.md`](docs/output.md).
- **`logs/`** — JSONL decision feed. Optional per-work-product nested logs are also picked up by the dashboard's activity glob.

See [`docs/architecture.md`](docs/architecture.md) for the full layout.

## Two runtimes, one role

Praxis distinguishes two operator profiles. Both consume the same role files:

- **Claude Code on the host** — the technical operator's runtime. `cd /path/to/role && claude`. `CLAUDE.md` loads, the agent works against the conventions with full file/shell access. Commits land under the operator's git identity as usual.
- **The dashboard's `/chat`** — the non-technical operator's runtime. The model is fed the role's interior as a system prompt (persona body, live verbs, hard rules, autonomy stance, tool catalog) so it embodies the role in conversation. Tool use is enabled and gated by `lib/autonomy.yaml` + `CONSTITUTIONAL_PATHS`. Conversations persist as markdown under `memory/conversations/`.

The chat surface exposes nine typed tools, grouped by intent:

- **Growth** — `write_memory`, `create_escalation`, `propose_verb`, `log_decision`. The role's own observational surfaces.
- **Lib surgery** — `append_entry`, `enrich_entry`, `adjust_param`. Operator-opened YAML under the modes declared in `lib/autonomy.yaml`.
- **Work product** — `write_output`, `update_output_status`. The framework's typed `output/` taxonomy.

Constitutional surfaces stay gated regardless of yaml. The chat is never the place to mutate the role's constitution — that's what `/triage/draft/<id>` co-authoring is for (operator-driven, model-assisted).

## Quickstart

The fastest way to seed a role and see it running — zero install, one command:

```bash
mkdir my-role && cd my-role
docker run --rm -p 4321:4321 \
  -v $(pwd):/role \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  ghcr.io/steveworley/praxis-framework/dashboard:latest
```

Open `http://localhost:4321/`. With nothing at the role root, the dashboard redirects to `/setup` — the wizard walks identity → voice → capabilities → hard inhibitions → optional starter verbs. On submit, two visible commits land in the mounted directory:

1. `feat: seed role from praxis-framework template` — populates `persona.md`, `CLAUDE.md`, `verbs/`, `lib/`, `memory/`, `escalations/`, `docker-compose.yml`, `.env.example`.
2. `chore: tidy framework-only files post-seed` — removes framework-only artefacts, replaces `README.md`.

After the wizard, kill the one-shot container with `Ctrl-C` and bring the stack up via the freshly-seeded compose file:

```bash
cp .env.example .env && vim .env   # set ANTHROPIC_API_KEY
docker compose up
```

> The GHCR image is currently private. Before the pull works, `docker login ghcr.io -u <username> -p $GITHUB_TOKEN` with a PAT carrying `read:packages`.

### Scripted setup (CI, reproducible roles)

For non-interactive seeding from a config file — useful for CI or version-controlled role definitions:

```bash
npm install -g @praxis-framework/cli
mkdir my-role && cd my-role
praxis init --config ./role.json --path .
```

A sample config lives at [`cli/examples/sample-role.json`](cli/examples/sample-role.json). The CLI also ships `praxis log` for appending JSONL decision lines from inside verb playbooks — see [`cli/README.md`](cli/README.md).

### Framework development

If you're contributing to praxis-framework itself (not seeding a role to operate):

```bash
git clone https://github.com/steveworley/praxis-framework.git
cd praxis-framework
docker compose up    # bind-mounts source for HMR via the dev Dockerfile
```

### After the role is populated

Drive it via either runtime — they consume the same files:

```bash
cd /path/to/my-role && claude              # technical operator
# or
docker compose up                          # non-technical operator → /chat
```

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
