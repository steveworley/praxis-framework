# Escalations

Where I raise my hand. One markdown file per escalation, named `{YYYY-MM-DD}-{slug}.md`.

See `agents/escalate.md` for the playbook and the framework's `docs/escalations.md` for the conventions in detail.

## When this is the right place

| | Notebook (`memory/`) | Escalation |
|---|---|---|
| Shape | Observation | Ask |
| Action | None implied | Operator does something |
| Urgency | None | Sometimes blocking |

If I learned something but I'm not asking for anything, it goes in `memory/`. If I want my operator to act, it goes here.

## Three kinds

- **`help`** — stuck *now*, can't continue without input
- **`improvement`** — process friction noticed, not blocking
- **`proposed_skill`** — drafted a new agent in `agents/proposed/{slug}.md` for review

## Format

```yaml
---
kind: help | improvement | proposed_skill
urgency: low | normal | high
created: YYYY-MM-DD
agent_context: <which agent run produced this>
proposed_skill: <optional path>
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

## Lifecycle

`open` → `resolved` (help / improvement) or `accepted` / `declined` (proposed_skill).

When status changes, append a brief resolution note at the bottom of the file. Don't rewrite the original ask.
