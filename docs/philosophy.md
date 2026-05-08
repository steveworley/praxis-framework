# Philosophy

## Role-based growth, not self-improvement

Self-improving agents rewrite their own playbook based on outcomes. That's powerful but unbounded — the constitution drifts, the supervisor loses the ability to predict what the agent will do, and small misjudgements compound into structural ones.

A role-based agent grows *within* a defined role:

- Voice and identity are authored, not discovered.
- Hard rules are explicit and never auto-mutated.
- Capabilities (`agents/`) can be revised, but only through a human-in-the-loop acceptance flow.
- Reference data (`lib/`) is owned by the role-author, not the agent.

The agent gets to grow in three places:

1. **Memory** — observational, persona-shaped notes about people, situations, patterns. Free-form. The agent owns relevance.
2. **Escalations** — structured asks for help, process improvements, or proposed new skills. The operator triages.
3. **Drafts of new skills** — the agent writes proposed agents into `agents/proposed/`; the operator decides whether to accept them.

The skill loop stays gated by design. Autonomous proposal, human-in-the-loop acceptance.

Beyond those three, a fourth place: **autonomous edits to operator-opened surfaces**. The model is differentiated, not graduated — different surfaces have different risk profiles, and `lib/autonomy.yaml` names which surfaces the role can edit directly and how (`append-only`, `inline-enrichment`, `bounded`). Constitutional surfaces (`agents/persona.md`, `agents/*.md`, `lib/customers.yaml`, `lib/compliance.yaml`, `CLAUDE.md`) stay gated forever — that's the line. See [autonomy.md](./autonomy.md) for the full model.

## Visible growth

Everything the agent learns is a file. Memory is markdown. Escalations are markdown. Drafts are markdown. A dashboard surfaces them.

This isn't an implementation detail — it's the point. The supervisor reads what the agent has noticed, what it's stuck on, what it wants to change. The agent's growth is legible to a human, not buried in vector embeddings.

## The four conventions

Praxis distills four directory conventions:

- **`agents/`** — modular playbooks. One markdown file per behavior. The role's verbs.
- **`lib/`** — declarative reference data. Role-authored, agent-readable.
- **`memory/`** — observational notebook. Agent-authored. Persona-shaped.
- **`escalations/`** — structured asks. Agent-authored. Operator-triaged.

Plus a fifth role-defined directory for **work product** — Sam uses `campaigns/`, a researcher might use `investigations/`, a triage agent might use `tickets/`. Praxis doesn't enforce a name; each role chooses what fits.

## Why directories, not abstractions

Directories are a contract everyone can read. A markdown agent file is the same shape whether it's drafting cold emails or triaging GitHub issues. A memory entry is the same shape whether it's about a customer or a teammate or a recurring pattern.

The dashboard parses the convention, not the role. The role-author writes the conventions, not the framework. Adding a new role doesn't require touching the framework.

## What Praxis is not

- **Not a runtime** — Claude Code (or eventually a hosted chat UI in Phase 2) is the runtime. Praxis is conventions + scaffolding + dashboard.
- **Not opinionated about LLM provider** — the agent runs wherever Claude Code runs.
- **Not a workflow engine** — agents are markdown prompts an LLM executes, not a DAG. Composition is up to the role-author.
- **Not a memory database** — memory is markdown files. Search is grep until it isn't.
