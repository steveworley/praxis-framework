# Autonomy

Praxis is built on the thesis that role-based agents grow within a defined role rather than self-improving without bound. But "no self-modification at all" is a strawman — real employees grow into their role by making bounded judgment calls without manager approval. The autonomy model is the praxis answer to *how much* a role can adjust on its own, and *which surfaces*.

## The frame

The mistake would be one knob ("autonomy: 0–10"). Different surfaces have different risk profiles. The model is **differentiated, not graduated** — autonomy is matched to risk per surface, not to time-in-role.

| Surface | Risk if the role gets it wrong | Default mode |
|---|---|---|
| `memory/` | Cluttered notes the operator prunes | **`full`** |
| `verbs/proposed/` | A bad draft the operator ignores | **`full`** |
| `escalations/` | Noise in the operator's queue | **`full`** |
| `lib/research-strategies.yaml` (or equivalent) | One missed page, recoverable | candidate for **`append-only`** |
| `lib/team.yaml` (notes / calibration text) | Stale calibration note | candidate for **`inline-enrichment`** |
| `lib/{warmup,operational-params}.yaml` | Overcautious or aggressive operation | candidate for **`bounded`** |
| `verbs/*.md` (existing playbooks) | Unpredictable behavioral drift | **`gated`** |
| `persona.md` | Identity drift | **`gated`** |
| `lib/customers.yaml` | Cold-emailing a customer, legal exposure | **`gated`** |
| `lib/compliance.yaml` | Spam Act / safety exposure | **`gated`** |
| `CLAUDE.md` | Behavior drift across all verbs | **`gated`** |

The principle: **gate by what could go wrong, not by what feels important.** A new path in `research-strategies.yaml` costs you a missed page if wrong; that's recoverable. An edit to `compliance.yaml` could end the project; that's not.

## The four modes

### `full`
The role can do anything in this directory or file. This is the default state of `memory/`, `verbs/proposed/`, and `escalations/` — surfaces where the role's own work is the entire content and there's nothing to corrupt.

### `append-only`
The role can add new entries to a list but never edit or delete existing entries. Pairs with a `max_pending` count: if the role appends N entries since the last operator commit on the file, and N reaches `max_pending`, the role stops appending and files an `improvement` escalation asking for compaction (operator reviews the additions, edits/removes any that don't earn their keep, signs off).

Use for: discovery heuristics, observed patterns, accumulated calibrations that are individually low-risk but collectively need pruning.

**The chat tool**: from `/chat`, the model uses `append_entry({path, entry})`. The framework reads the surface's autonomy.yaml entry to find the YAML list key (`root_key`), the duplicate-detection field (`unique_by`), and the unreviewed-entry ceiling (`max_pending`). The full shape:

```yaml
# lib/autonomy.yaml
surfaces:
  - path: lib/research-strategies.yaml
    mode: append-only
    max_pending: 5
    root_key: strategies      # the list at the top of the YAML file
    unique_by: id             # field on each entry that must be unique
    why: |
      Org-type page conventions I notice while running find-contacts.
```

And a matching file the role appends to:

```yaml
# lib/research-strategies.yaml
strategies:
  - id: au-tafes-leadership
    pattern: "AU TAFEs: leadership at /about/leadership"
    observed: 2026-04-12
    confidence: high
    reviewed: true            # operator has reviewed this entry
  - id: multi-brand-au-institutes
    pattern: "Multi-brand AU institutes: corporate page on parent subdomain"
    observed: 2026-04-15
    confidence: medium
    reviewed: false           # still unreviewed (counts toward max_pending)
```

**How pending entries are counted**: each entry carries a `reviewed: false` marker; `append_entry` injects it automatically if the model doesn't set it. The operator flips it to `reviewed: true` after reviewing (manually in their IDE for now). When the count of `reviewed: false` entries reaches `max_pending`, the next append refuses with a clear message — the role's expected response is to file an `improvement` escalation suggesting compaction.

**Duplicate detection**: if `unique_by` is declared and the incoming entry's value collides with an existing entry, the append refuses. The role can't use append-only to edit; structural changes to an existing entry need an escalation.

### `inline-enrichment`
The role can update soft fields (notes, calibration text, enrichment strings) within existing structured entries. The role never adds new top-level entries or removes existing ones; structural changes go through escalation.

Use for: reference data where structure is operator-owned but the soft texture per-entry is the role's lived experience.

**The chat tool**: from `/chat`, the model uses `enrich_entry({path, entry_id, soft_fields})`. The framework reads the surface's autonomy.yaml entry to find the YAML list key (`root_key`), the entry-identifier field (`unique_by`), and the whitelist of fields the role may touch (`soft_fields`). The full shape:

```yaml
# lib/autonomy.yaml
surfaces:
  - path: lib/team.yaml
    mode: inline-enrichment
    root_key: members
    unique_by: id
    soft_fields:
      - notes
      - last_observed_at
    why: |
      Structured team data is operator-owned (name, role, email), but the
      role keeps the notes column current with what it observes in
      day-to-day interactions.
```

And a matching file the role enriches:

```yaml
# lib/team.yaml
members:
  - id: steve
    name: Steve Worley         # operator-owned (hard)
    role: Operator             # operator-owned (hard)
    email: sj.worley88@gmail.com  # operator-owned (hard)
    notes: morning person; pings via Slack for anything urgent.  # soft
    last_observed_at: 2026-05-08                                  # soft
```

**Refusals the role sees**: missing `soft_fields` / `unique_by` declaration in autonomy.yaml; surface in a different mode; no entry with the given `entry_id` (inline-enrichment can't create entries — file a `proposed_skill` escalation if a new entry shape is needed); a supplied key isn't in the whitelist (the refusal lists the declared soft fields so the role can self-correct).

### `bounded`
The role can adjust parameters within ranges the operator has set. The bounds live alongside the entry in `lib/autonomy.yaml`.

Use for: operational parameters where there's a clear safe range (e.g. retry counts, wave thresholds, daily limits). The operator sets the band; the role adapts within it.

**The chat tool**: from `/chat`, the model uses `adjust_param({path, key, value})`. The framework reads the surface's autonomy.yaml entry to find the per-parameter `bounds` block. Each parameter declares `min` and `max` (required) and optionally `step` (when set, the value must be a multiple of `step` starting from `min`). The full shape:

```yaml
# lib/autonomy.yaml
surfaces:
  - path: lib/warmup.yaml
    mode: bounded
    bounds:
      sends_per_day: { min: 10, max: 100, step: 5 }
      weeks_to_full_send_rate: { min: 4, max: 12 }
      new_thread_ratio: { min: 0.1, max: 0.9 }
    why: |
      Warmup throttle parameters. The role can adjust based on observed
      deliverability; operator-set ceilings cap risk.
```

And a matching file the role tunes:

```yaml
# lib/warmup.yaml — operator-authored ceilings, role tunes within
sends_per_day: 25
weeks_to_full_send_rate: 6
new_thread_ratio: 0.3
```

The file is a flat top-level `key: value` map. The role can only adjust keys declared in `bounds` — keys absent from the bounds map are operator-only. The block-mapping form `sends_per_day:\n  min: 10\n  max: 100\n  step: 5` is also accepted in autonomy.yaml for operators who prefer that style.

**Refusals the role sees**: missing `bounds` declaration in autonomy.yaml; surface in a different mode; key not in `bounds` (the refusal lists the declared bounded keys); value below `min`, above `max`, or not a multiple of `step` starting from `min`. Floating-point comparison uses a small tolerance (`1e-9`) so step-aligned decimals (`0.1 + 4*0.05 = 0.3`) pass cleanly.

### `gated` (default)
The role never edits autonomously. Everything is gated unless explicitly opened in `lib/autonomy.yaml`.

## The three guarantees

Whatever surfaces are open, three things hold:

1. **Visibility** — every autonomous edit is a git commit signed by the role (`--author="{role full name} <{role email}>"`). The dashboard's `/role` page surfaces "Recent edits by {role}" with a diff preview. Operators read it like a manager reviewing a direct report's working files.

   Actor convention: dashboard-mediated commits use two synthetic identities so `git log --author=` filtering stays clean — `Praxis Role <role@praxis.local>` for autonomous chat-side writes (`write_memory`, `create_escalation`, `propose_verb`, `log_decision`), and the operator's configured `user.name`/`user.email` (falling back to `Operator <operator@praxis.local>` when no git identity is set) for triage-side actions (accept/decline/comment escalations, accept/decline/edit proposed verbs). Commit subjects follow conventional-commit shape: `role(<scope>): <subject>` and `operator(triage): <subject>` respectively. Operators who drive the role via Claude Code commit under their own git identity as usual — the synthetic actors only apply to dashboard-mediated mutations.

2. **Reversibility** — `git revert <sha>` is the rollback. Every autonomous edit is one commit, attributed to the role, on a known set of paths. No autonomous edit is irreversible.

3. **Lock toggle** — `lib/autonomy.yaml` is operator-authored. Any surface can be downgraded to `gated` with a one-line edit. If the role starts making changes the operator keeps reverting, the operator pulls the lever.

## The starter shape

For most roles, open this minimal surface first:

```yaml
# lib/autonomy.yaml
surfaces:
  - path: lib/research-strategies.yaml   # or equivalent for the role
    mode: append-only
    max_pending: 5
    why: |
      Org-type page conventions and discovery heuristics I notice while
      running research-shaped agents.
```

Why first:
- High-friction surface — the role *will* discover patterns across runs
- Append-only is the safest mode (no destructive risk)
- Validates the visibility + revert mechanism on a low-stakes surface
- Concrete near-term ROI (every accepted addition speeds the next batch)

After this surface earns its keep, expand to `inline-enrichment` on team data, then `bounded` on operational parameters, then consider whether any specific verb file is safe for autonomous minor edits. **`persona.md` and the constitutional surfaces stay gated forever** — that's the line.

## What this is not

- **Not Hermes.** The role doesn't self-modify behavior based on outcomes. Capability changes still go through HiTM acceptance via `verbs/proposed/`. The autonomous surfaces are *additive observations*, not behavioral mutations.
- **Not graduated trust over time.** The role doesn't "level up" autonomy by accumulating successful edits. Autonomy is per-surface and operator-controlled. If you want to expand it, you edit `lib/autonomy.yaml`.
- **Not a replacement for escalations.** Autonomous edit and escalation are complementary. Escalation is for things the operator should *act* on (or know about). Autonomous edits are for things the role can do safely on its own. The reflection beat fires both.

## Operator reflex

When you read the dashboard's "Recent edits by {role}" feed:

- **Most edits should be obvious wins** — small, scoped, additive. Skim them, move on.
- **A few will be wrong** — the role drew the wrong conclusion from a pattern. `git revert <sha>`, optionally write a memory entry of your own naming why it was wrong (the role reads `memory/` too, eventually).
- **Recurring revert patterns are signal** — if you keep reverting the same shape of edit, that's evidence the surface is wrongly modeled as autonomous. Downgrade it in `lib/autonomy.yaml`.

The autonomy model fails gracefully: the worst-case edit produces one git commit you revert. The system doesn't depend on the role being right.
