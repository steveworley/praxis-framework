# Escalations

The role's raise-your-hand surface. One markdown file per escalation, named `escalations/{YYYY-MM-DD}-{slug}.md`.

## The three kinds

- **`help`** — stuck *now* on a specific task that can't continue without input. Blocking.
- **`improvement`** — process friction or gap noticed. Not blocking. File-and-forget.
- **`proposed_skill`** — the role drafted a new verb. The draft itself goes in `verbs/proposed/{slug}.md`; the escalation describes what it does and why.

The role picks the kind based on the *ask*, not the observation:

- Would the work continue if the operator never replied? If yes, it's `improvement`. If no, it's `help`.
- Is the role asking for review of a written draft? `proposed_skill`.

## Format

```yaml
---
kind: help | improvement | proposed_skill
urgency: low | normal | high
created: YYYY-MM-DD
agent_context: <which verb run produced this>
proposed_skill: <optional path to verbs/proposed/{slug}.md>
status: open
---
```

Body sections (in order): **What I was doing**, **What I tried**, **What I'm asking for**.

Be specific. "Help me with this" is unactionable; "should I send this draft despite the public-domain risk, or hold for verification?" is what the operator can act on.

## Lifecycle

`open` → `resolved` (help / improvement) or `accepted` / `declined` (proposed_skill).

When the operator changes status, append a brief resolution note at the bottom of the file. Don't rewrite the original ask — the history reads cleanly when both sides are preserved.

## Acceptance flow for `proposed_skill`

1. Role drafts the new playbook in `verbs/proposed/{slug}.md`.
2. Role files the escalation referencing the draft.
3. Operator reviews on the dashboard or in their session.
4. **Accept**: operator moves the file from `verbs/proposed/` to `verbs/`, sets escalation `status: accepted`.
5. **Decline**: operator sets `status: declined`, adds a one-line reason. The draft stays in `proposed/` as a record.

Don't delete declined drafts — the trajectory of what didn't make the cut, and why, is useful.

## What escalations aren't

- **Not memory entries** — those are observations with no ask.
- **Not commit messages** — escalations describe a question or proposal, not a change that already happened.
- **Not retrospectives** — they're about the work, not about the role's process improvement (which is what `improvement` is for, narrowly scoped).

## Hard rules for the role

- NEVER move a draft from `verbs/proposed/` to `verbs/`. The acceptance gate is human-in-the-loop by design.
- NEVER edit an existing verb in `verbs/` on its own initiative. File an `improvement` escalation and let the operator decide.
- NEVER overwrite an existing escalation. Append a comment block or file a fresh one with a link to the older slug.
- NEVER mark `status: accepted` / `declined` on its own drafts. Operator owns the resolution.
