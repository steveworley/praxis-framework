# Decisions

Praxis records *what* an agent did via JSONL action logs and stage transitions. The decisions primitive records *why* — the deliberation behind each non-trivial choice. Operators use it to calibrate the role; the role uses it to notice patterns it's drifting on.

## The frame

A role makes hundreds of judgment calls per run. Some are obvious (the stage transition is mechanical, the choice was forced). Most aren't:

- Find-contacts picks Karl Hartmann at APRA, not Mary Smith or John Wei. Why?
- Draft-emails chooses a sovereignty angle over cost-saving. Why?
- Pre-send-check marks `currency: in_role` based on a screenshot, a paragraph, a name in a list. Why was that evidence enough?
- Monitor-channels classifies a Slack message as "lead" rather than "skip". Which signals swung it?

Without a deliberation log, when one of these turns out wrong (a bounce, a flat reply, a missed opportunity), there's nothing to audit. The outcome is visible; the reasoning isn't. The role can't learn from its own past unless it can see what it was thinking at the time.

## The primitive

A decision is a `bin/log` entry with `action=decision` and a small set of conventional extras. No new tooling, no new file storage — it rides the existing JSONL log infrastructure.

```bash
bin/log --campaign={id} --agent={agent} --action=decision \
        --prospect={if applicable} \
        decision_type='contact_selection' \
        chosen='Karl Hartmann (CTO / Head of Central Services)' \
        considered='Mary Smith (Director Risk), John Wei (CDO — left 2024)' \
        rationale='Title best matches the buyer profile. Tenure 3+ years per LinkedIn. Smith is risk-side not infra-side. Wei left the org in 2024.' \
        confidence='high'
```

### Schema

| Field | Required | Shape | Notes |
|---|---|---|---|
| `decision_type` | yes | one of the conventional kinds (below) or a free-text label | filterable on the dashboard |
| `chosen` | yes | one-line description of the choice | what got picked |
| `considered` | no | comma-separated alternatives weighed | helps retrospective audit |
| `rationale` | yes | free text | the *why*; if you'd write "obvious", don't log it |
| `confidence` | no | `low` / `medium` / `high` | calibration signal — operators can review high-confidence calls that turned out wrong |

The fields ride `bin/log`'s `key=value` extras mechanism, so no script changes needed. Agents adopt the schema by following their playbook.

### Conventional `decision_type` values

| Value | Used by | Trigger |
|---|---|---|
| `contact_selection` | find-contacts | Picking which person at an org |
| `qualification_verdict` | research | Setting a prospect to qualified vs skipped |
| `angle_choice` | draft-emails | Choosing the framing / pitch angle for a draft |
| `currency_verdict` | pre-send-check | Verifying a contact is still in role |
| `intake_classification` | monitor-channels | Lead vs noise vs existing-customer signal |
| `reply_classification` | monitor | Warm reply vs cold response vs bounce |
| `routing` | any | Handing off between agents |
| `other` | any | Anything else with two-or-more reasonable options |

Roles can extend this list with their own `decision_type` values. The framework doesn't enforce — the convention is just a starting set.

## Gates: where decisions must be recorded

Each agent's playbook should include a "before this transition, log a decision" step at every non-obvious choice point. The discipline lives in the agent file, not in code:

> ## Decision gate
>
> Before setting `stage = contact_found`, log the contact selection:
>
> ```bash
> bin/log --campaign={id} --agent=find-contacts --action=decision --prospect={slug} \
>         decision_type=contact_selection chosen='...' considered='...' rationale='...' confidence=...
> ```

The framework provides the convention; roles instrument their own agents. Skipping a decision log isn't gated by code — it's gated by the playbook. The same way "log every action" is gated.

## Dashboard surface

The `/activity` page filters to `action=decision` rows and renders them distinctly:

- The standard time / verb / what columns
- Plus an indented block under each decision showing **chosen**, **considered**, **rationale**, **confidence**
- Filter chip "decisions only" (in addition to existing per-action filters)
- Optionally: per-`decision_type` sub-filter

Operators read the dashboard view to:

- **Calibrate the role** — high-confidence decisions that turned out wrong are calibration signal
- **Audit retrospectively** — when a bounce/miss happens, scan back through the decisions on that prospect to find the reasoning failure
- **Spot drift** — if the role's `confidence: high` calls have a consistent failure shape, the heuristic is wrong

The role reads its own decisions to:

- Notice patterns at the reflection beat (recurring `decision_type` that gets reverted/rejected — the heuristic is wrong)
- Reuse rationales — past good calls inform future similar calls
- Surface to the operator when a gut check disagrees with a past decision

## What this is not

- **Not a replacement for stage history.** `prospect.history[]` still tracks transitions. Decisions are the deliberation *for* a transition, not the transition itself.
- **Not for every action.** Routine, mechanical actions don't need a decision. If you'd write "obvious" as the rationale, don't log it.
- **Not gated by code.** A missing decision doesn't block a stage transition. The discipline is in the playbook. (We could add code-level gates later — refusing to commit a stage change without a corresponding decision row — but the convention works for v1.)
- **Not a structured-reasoning store.** Decisions are short, narrative-shaped log entries. Long-form deliberation belongs in `memory/notes/` or escalations. Decisions are the headlines, not the essays.

## Operator reflex

When you read the `/activity` decisions feed:

- **Skim high-confidence decisions** — these are the ones the role committed to. If one looks wrong, that's calibration signal worth a memory entry of your own.
- **Read low-confidence decisions** — the role flagged uncertainty. If the call was the right one, your read of why it was right is worth surfacing back (a reply / Slack message / direct edit to the rationale on the next pass).
- **Cluster by `decision_type`** — see the role's call distribution. Is it picking aggressive angles too often? Skipping too readily? The pattern across decisions is signal that one outcome can't show.

The decisions feed makes the role's judgment legible. Memory is what the role noticed. Decisions are what the role chose. Together they're how a role-based agent stays calibrated over time without becoming opaque.
