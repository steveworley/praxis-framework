# Interior

The agent's **interior** is everything it knows that isn't structured reference data: observations about people, soft account context, voice calibrations, ongoing situations, raise-your-hand requests, drafts of new skills.

The dashboard surface for the interior is read-only. The supervisor watches; the agent writes.

## Two surfaces

| | Memory (`memory/`) | Escalations (`escalations/`) |
|---|---|---|
| Shape | Observation | Ask |
| Action implied | None — passive recording | Operator does something |
| Urgency | None | Sometimes blocking |
| Lifecycle | Append, occasionally update | Open → resolved / accepted / declined |

If the agent learned something but isn't asking for anything, it goes in memory. If it wants the operator to act, it goes in escalations.

## Memory conventions

Free-form markdown, organised loosely under `people/`, `accounts/`, `notes/`. The agent can spawn new categories — that's signal about what it's noticing.

### Two rules that earn their keep

1. **Don't shadow structured files.** If something belongs in `lib/` or `persona.md`, write it there. Memory is for relational and observational content with no other home.
2. **Timestamp everything.** Without dates the longitudinal shape of growth is invisible.

### When the agent writes

- **End of a run.** Before reporting back, pause and ask: did anything shift my picture of a person, an account, or my own voice?
- **On surprise.** When an outcome diverges from expectation — that gap is signal.

The test for whether something is memory-worthy: *would future-me benefit from this if I had no access to logs, structured files, or the dashboard?*

## What memory isn't

- **Not engineering preferences** — those go in the harness auto-memory (the runtime's project-level memory). Memory is persona-shaped, not operator-shaped.
- **Not a log** — logs go in the work-product directory. Memory is reflection.
- **Not a CRM** — accounts in `lib/customers.yaml` are facts; `memory/accounts/{domain}.md` is texture.

## Escalation conventions

Three kinds:

- **`help`** — stuck *now* on a specific task. Blocking. Surface inline if `urgency: high`.
- **`improvement`** — process friction or gap noticed. Not blocking. File-and-forget.
- **`proposed_skill`** — agent drafted a new playbook. Operator reviews and accepts or declines.

### The acceptance gate

The agent never moves a draft from `agents/proposed/` to `agents/`. The operator does, after reviewing the escalation. That's the constitution: autonomous proposal, human-in-the-loop acceptance.

The agent never edits an existing agent in `agents/` to "fix" it. It files an `improvement` escalation describing the change, and the operator decides.

## Why this matters

The interior is how the agent grows. The conventions are deliberately light — file-based, markdown, no schemas — because the *shape* of what an agent notices is itself the data. Praxis surfaces the artifacts; the operator interprets them.
