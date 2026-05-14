# Escalations

The role's raise-your-hand surface. One markdown file per escalation, named `escalations/{YYYY-MM-DD}-{slug}.md`.

## The four kinds

- **`help`** — stuck *now* on a specific task that can't continue without input. Blocking.
- **`improvement`** — process friction or gap noticed. Not blocking. File-and-forget.
- **`proposed_skill`** — the role drafted a new verb. The draft itself goes in `verbs/proposed/{slug}.md`; the escalation describes what it does and why.
- **`criterion_drift`** — a declared success criterion (see `## Success criteria` in `persona.md`) has trended away from green across multiple self-assessments. File when the role notices ≥2 consecutive amber/red statuses for the same criterion. Carries three required frontmatter fields: `criterion`, `trend`, `runs` (see Format below).

The role picks the kind based on the *ask*, not the observation:

- Would the work continue if the operator never replied? If yes, it's `improvement`. If no, it's `help`.
- Is the role asking for review of a written draft? `proposed_skill`.
- Is the role flagging that a success criterion has been amber/red for ≥2 reflections? `criterion_drift`.

## Format

```yaml
---
kind: help | improvement | proposed_skill | criterion_drift
urgency: low | normal | high
created: YYYY-MM-DD
agent_context: <which verb run produced this>
proposed_skill: <optional path to verbs/proposed/{slug}.md, only on kind=proposed_skill>
criterion: <required when kind=criterion_drift — verbatim text from persona.md>
trend: <required when kind=criterion_drift — e.g. green→amber, amber→red>
runs: <required when kind=criterion_drift — integer ≥1, consecutive non-green count>
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
3. Operator reviews on the dashboard (`/triage`) or in their session.
4. **Accept**: from `/triage`, click *Accept* on the proposed verb. The dashboard atomically moves `verbs/proposed/{slug}.md` to `verbs/{slug}.md`, flips frontmatter `status: accepted`, and (best-effort) appends a row to `CLAUDE.md`'s verbs table. Optionally use *Edit before accept* to refine the prompt body before promoting.
5. **Decline**: click *Decline* and supply a reason. The draft's frontmatter is updated to `status: declined` with the reason recorded, and the file stays in `verbs/proposed/` as a record.

Don't delete declined drafts — the trajectory of what didn't make the cut, and why, is useful.

## Operator review surface

The dashboard's `/triage` page is the supported review surface. It supports:

- **Accept / Decline / Comment** on any open escalation (`help`, `improvement`, `proposed_skill`). All three append a timestamped `## Operator note` block to the escalation file so the history reads as a conversation.
- **Accept / Decline / Edit / Edit-and-accept** on any proposed verb. Edit opens an inline textarea pre-filled with the draft body.
- The nav tab shows a count badge when the queue is non-empty; the home page shows a one-line "N items in triage" strip.

Operators can also still resolve escalations by hand-editing the markdown — the dashboard is the convenient surface, not the only one. The disk shape is the source of truth.

## What escalations aren't

- **Not memory entries** — those are observations with no ask.
- **Not commit messages** — escalations describe a question or proposal, not a change that already happened.
- **Not retrospectives** — they're about the work, not about the role's process improvement (which is what `improvement` is for, narrowly scoped).

## Hard rules for the role

- NEVER move a draft from `verbs/proposed/` to `verbs/`. The acceptance gate is human-in-the-loop by design.
- NEVER edit an existing verb in `verbs/` on its own initiative. File an `improvement` escalation and let the operator decide.
- NEVER overwrite an existing escalation. Append a comment block or file a fresh one with a link to the older slug.
- NEVER mark `status: accepted` / `declined` on its own drafts. Operator owns the resolution.
