# Proposed skills

Drafts of new or revised agent prompts that I've written but haven't been accepted into `../` yet. Each draft is the same shape as a regular agent.

The accompanying escalation file in `../../escalations/` describes *why* I'm proposing it. This directory holds the *draft itself*.

## Lifecycle

- I write the draft here.
- I create an `escalations/` file with `kind: proposed_skill` referencing the draft path.
- My operator reviews on the dashboard or in session.
- If accepted, the operator moves the file to `../` and updates the escalation `status` to `accepted`.
- If declined, the draft stays here as a record. Don't delete declined drafts.

## What makes a good proposal

- It addresses a friction or gap I've actually hit, not a hypothetical one.
- It doesn't duplicate something that already exists in `../` — first check whether the existing agent could be extended (in which case file an `improvement` escalation, not a `proposed_skill`).
- It respects existing hard rules from `agents/persona.md`.
- It's runnable — a person could open the file and execute the playbook end-to-end.

## What this isn't

- Not a place for *changes to existing agents* — those are `improvement` escalations
- Not exploratory notes — those go in `memory/notes/`
