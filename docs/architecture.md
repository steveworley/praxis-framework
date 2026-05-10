# Architecture

## Directory shape

A Praxis role lives in one directory. The convention:

```
{role-home}/
├── CLAUDE.md                  # operating manual the runtime reads on session start
├── persona.md                 # who the role is, voice, hard rules (role identity)
├── verbs/                     # modular playbooks (the role's verbs)
│   ├── {verb-name}.md         # one file per repeatable behavior
│   └── proposed/              # drafts awaiting acceptance (role writes here, never to ../)
├── lib/                       # declarative reference data
│   └── *.yaml                 # role-authored, verb-readable
├── memory/                    # observational notebook (role writes)
│   ├── README.md              # format + conventions
│   ├── people/                # contacts, teammates, external relationships
│   ├── accounts/              # softer narrative context (or rename to fit role)
│   └── notes/                 # voice calibrations, ongoing situations, anything else
├── escalations/               # structured asks (role writes; operator triages)
│   ├── README.md              # format + lifecycle
│   └── {date}-{slug}.md       # one file per escalation
└── {work-product}/            # role-named directory for the actual output
                               # Sam uses `campaigns/`; choose what fits the role.
```

`persona.md` lives at the role root because it's identity, not behaviour — alongside `CLAUDE.md`, both are role-root constitution files. Universal directories are fixed: `verbs/`, `lib/`, `memory/`, `escalations/`. The work-product directory is role-named.

## What lives where

| Question | Where it goes |
|---|---|
| "Who am I?" | `persona.md` |
| "How do I work?" | `CLAUDE.md` (top-level operating manual) |
| "What are my repeatable behaviors?" | `verbs/{name}.md` |
| "What's my world?" (customers, team, rules, capabilities) | `lib/*.yaml` |
| "What did I notice?" | `memory/{people,accounts,notes}/{slug}.md` |
| "I need help / want to propose a change" | `escalations/{date}-{slug}.md` |
| "I drafted a new behavior" | `verbs/proposed/{name}.md` + an escalation referencing it |
| "What did I do?" | `{work-product}/{...}/logs/{date}.jsonl` (role-named) |

## File formats

### Verb file (`verbs/{name}.md`)

Markdown with optional frontmatter (Phase 4 will introduce a verb-tag taxonomy here):

```markdown
---
verb: intake | research | decide | produce | review | act | monitor | respond | reflect
when_to_run: <description>
inputs: [<paths or sources>]
outputs: [<artifacts produced>]
---

# {Verb name}

You are {persona ref}. {What this verb does in one sentence.}

**Read `persona.md` first.** {Any voice notes specific to this behavior.}

## When to run
...

## Inputs
...

## What you do
1. ...
2. ...

## Hard rules
- NEVER ...

## Reporting
{What to surface back at the end of a run.}
```

Frontmatter is optional today; Phase 4 makes it the basis for verb-tag grouping in the dashboard.

### Memory entry (`memory/{category}/{slug}.md`)

```markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# {Title}

{Free-form body. The agent decides relevance and structure.}
```

### Escalation (`escalations/{date}-{slug}.md`)

```markdown
---
kind: help | improvement | proposed_skill
urgency: low | normal | high
created: YYYY-MM-DD
agent_context: <which verb run produced this>
proposed_skill: <optional path to verbs/proposed/{name}.md>
status: open
---

# {Short title}

## What I was doing
...

## What I tried
...

## What I'm asking for
...
```

### Work-product layout (role-defined)

The role-author chooses the work-product directory name and shape. A common pattern Sam uses:

```
{work-product}/
└── {item-id}/
    ├── config.yaml
    ├── state/{...}.json
    ├── logs/{date}.jsonl
    └── ...
```

But this is illustrative — Praxis doesn't enforce it.

## CLAUDE.md

The operating manual the runtime reads on session start. Should include:

- **Identity preamble** — "You are {persona}; read `persona.md` first"
- **Verbs table** — what verbs exist, when each runs, input → output
- **Pipeline / workflow** — how verbs compose (if applicable)
- **What I anchor on** — pointers to lib/ files, persona, etc.
- **Hard rules** — concise list, with pointers to where they're enforced
- **Memory conventions** — when to write, two-surface split, the test
- **Escalation conventions** — three kinds, when to file, the gate

See [`creating-a-role.md`](creating-a-role.md) for a walkthrough.

## The role-runtime boundary

Praxis is conventions + dashboard. It is *not* the runtime.

Today: Claude Code on the host is the runtime. The operator opens a Claude Code session in the role's directory; CLAUDE.md loads; the agent works against the conventions.

Phase 2: a hosted chat UI replaces the Claude Code session. The runtime moves into the framework. Until then, host-side Claude Code remains the agent loop.

## The Interior dashboard

A read-only supervisor surface. Reads the role's conventions and renders:

- **Persona** — parsed from `persona.md` (identity, voice, role)
- **Memory** — entries from `memory/`, recency-sorted, filterable by category
- **Escalations** — triage queue from `escalations/`, sorted by status + urgency
- **Activity** — recent verb runs (parsed from logs)

Phase 1 dockerizes this. Phase 3 adds a role-planning UX. Phase 4 adds verb-tag grouped views. Phase 2 makes the dashboard the runtime UI.
