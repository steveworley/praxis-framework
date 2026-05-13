<p>
  <img src="docs/assets/praxis-logo.png" alt="Praxis" width="360" />
</p>

_role-based agents that fit your business_

---

A framework for **role-based agents that grow into a defined role** — not self-improving agents that drift on their own. You author the role; the agent grows within its bounds, surfaces what it learns, and asks for help when it can't decide.

Built around `persona.md` at the role root (the role's identity) plus four directory conventions:

- **`verbs/`** — modular markdown playbooks the role runs. One file per repeatable behavior.
- **`lib/`** — declarative reference data (the world the role operates in). The role-author owns this.
- **`memory/`** — observational notebook the role writes itself. Persona-shaped, longitudinal, visible.
- **`escalations/`** — raise-your-hand surface. The role files structured asks (help / improvement / proposed_skill); the operator triages from the dashboard.

Plus a read-only **Interior** dashboard for the operator — surfaces the agent's persona, memory, escalations, and activity.

## Why role-based, not self-improving

A self-improving agent rewrites its own playbook. That's powerful, and unbounded. A role-based agent works within a role you define — voice, hard rules, capabilities, behaviors — and asks before it changes the playbook. The constitution stays explicit; the agent's growth is visible and gated.

The pattern was extracted from a real BD agent (Sam Parker, Quant). Praxis distills the conventions; Sam stays the reference implementation in [`examples/`](examples/).

## Quickstart

The framework repo *is* the seed. Clone it, run the dashboard, and the **/setup wizard** converts the clone in place into a populated role. To run another role, clone the framework again into a different path.

```bash
git clone https://github.com/steveworley/praxis-framework.git my-role
cd my-role/dashboard
npm install
npm run dev
```

Open `http://localhost:4321/` — `/` redirects to `/setup` because `persona.md` doesn't exist at the role root yet. Walk through the wizard (identity, voice, capabilities, inhibitions, optional starter verbs). On submit, the wizard writes two visible git commits:

1. `feat: seed role from praxis-framework template` — populates `CLAUDE.md`, `persona.md`, `verbs/`, `lib/`, `memory/`, `escalations/` with your inputs
2. `chore: tidy framework-only files post-seed` — removes `template/`, `examples/`, `scripts/`, replaces `README.md`

After seeding, `/` redirects to `/interior` — the read-only supervisor surface that watches the role grow over time.

To drive the role, attach Claude Code to the same directory:

```bash
cd /path/to/my-role && claude
```

### Run the dashboard via Docker (Phase 1)

```bash
cd my-role
docker compose up
```

Mounts the role's repo into the container and runs the dashboard at `http://localhost:4321/`. The wizard writes back to the host clone through the volume mount.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the directory shape, [`docs/creating-a-role.md`](docs/creating-a-role.md) for the bootstrap walkthrough, [`docs/philosophy.md`](docs/philosophy.md) for why the conventions are shaped this way, and [`docs/comparison.md`](docs/comparison.md) for how praxis compares to self-improving agent frameworks.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Conventions + template + read-only dashboard + docs | in progress |
| 1 | Dockerize the dashboard; `PRAXIS_ROLE_HOME` as a volume mount | next |
| 3 | Role planning UX — guided persona builder on the dashboard | planned |
| 4 | Verb-tag taxonomy — verbs declare a category in frontmatter, dashboard groups by tag | planned |
| 2 | Hosted chat UI — replaces Claude Code with an in-dashboard runtime | last |

Phase 2 is deliberately the last milestone. Until it ships, Claude Code on the host is the runtime; the dashboard is the operator's read-only window into the agent's interior.

## License

MIT.
