# Autonomy

Praxis is built on the thesis that role-based agents grow within a defined role rather than self-improving without bound. But "no self-modification at all" is a strawman — real employees grow into their role by making bounded judgment calls without manager approval. The autonomy model is the praxis answer to *how much* a role can adjust on its own, and *which surfaces*.

## The frame

The mistake would be one knob ("autonomy: 0–10"). Different surfaces have different risk profiles. The model is **differentiated, not graduated** — autonomy is matched to risk per surface, not to time-in-role.

| Surface | Risk if the role gets it wrong | Default mode |
|---|---|---|
| `memory/` | Cluttered notes the operator prunes | **`full`** |
| `agents/proposed/` | A bad draft the operator ignores | **`full`** |
| `escalations/` | Noise in the operator's queue | **`full`** |
| `lib/research-strategies.yaml` (or equivalent) | One missed page, recoverable | candidate for **`append-only`** |
| `lib/team.yaml` (notes / calibration text) | Stale calibration note | candidate for **`inline-enrichment`** |
| `lib/{warmup,operational-params}.yaml` | Overcautious or aggressive operation | candidate for **`bounded`** |
| `agents/*.md` (existing playbooks) | Unpredictable behavioral drift | **`gated`** |
| `agents/persona.md` | Identity drift | **`gated`** |
| `lib/customers.yaml` | Cold-emailing a customer, legal exposure | **`gated`** |
| `lib/compliance.yaml` | Spam Act / safety exposure | **`gated`** |
| `CLAUDE.md` | Behavior drift across all agents | **`gated`** |

The principle: **gate by what could go wrong, not by what feels important.** A new path in `research-strategies.yaml` costs you a missed page if wrong; that's recoverable. An edit to `compliance.yaml` could end the project; that's not.

## The four modes

### `full`
The role can do anything in this directory or file. This is the default state of `memory/`, `agents/proposed/`, and `escalations/` — surfaces where the role's own work is the entire content and there's nothing to corrupt.

### `append-only`
The role can add new entries to a list but never edit or delete existing entries. Pairs with a `max_pending` count: if the role appends N entries since the last operator commit on the file, and N reaches `max_pending`, the role stops appending and files an `improvement` escalation asking for compaction (operator reviews the additions, edits/removes any that don't earn their keep, signs off).

Use for: discovery heuristics, observed patterns, accumulated calibrations that are individually low-risk but collectively need pruning.

### `inline-enrichment`
The role can update soft fields (notes, calibration text, enrichment strings) within existing structured entries. The role never adds new top-level entries or removes existing ones; structural changes go through escalation.

Use for: reference data where structure is operator-owned but the soft texture per-entry is the role's lived experience.

### `bounded`
The role can adjust parameters within ranges the operator has set. The bounds live alongside the entry in `lib/autonomy.yaml`.

Use for: operational parameters where there's a clear safe range (e.g. retry counts, wave thresholds, daily limits). The operator sets the band; the role adapts within it.

### `gated` (default)
The role never edits autonomously. Everything is gated unless explicitly opened in `lib/autonomy.yaml`.

## The three guarantees

Whatever surfaces are open, three things hold:

1. **Visibility** — every autonomous edit is a git commit signed by the role (`--author="{role full name} <{role email}>"`). The dashboard's `/role` page surfaces "Recent edits by {role}" with a diff preview. Operators read it like a manager reviewing a direct report's working files.

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

After this surface earns its keep, expand to `inline-enrichment` on team data, then `bounded` on operational parameters, then consider whether any specific agent file is safe for autonomous minor edits. **`agents/persona.md` and the constitutional surfaces stay gated forever** — that's the line.

## What this is not

- **Not Hermes.** The role doesn't self-modify behavior based on outcomes. Capability changes still go through HiTM acceptance via `agents/proposed/`. The autonomous surfaces are *additive observations*, not behavioral mutations.
- **Not graduated trust over time.** The role doesn't "level up" autonomy by accumulating successful edits. Autonomy is per-surface and operator-controlled. If you want to expand it, you edit `lib/autonomy.yaml`.
- **Not a replacement for escalations.** Autonomous edit and escalation are complementary. Escalation is for things the operator should *act* on (or know about). Autonomous edits are for things the role can do safely on its own. The reflection beat fires both.

## Operator reflex

When you read the dashboard's "Recent edits by {role}" feed:

- **Most edits should be obvious wins** — small, scoped, additive. Skim them, move on.
- **A few will be wrong** — the role drew the wrong conclusion from a pattern. `git revert <sha>`, optionally write a memory entry of your own naming why it was wrong (the role reads `memory/` too, eventually).
- **Recurring revert patterns are signal** — if you keep reverting the same shape of edit, that's evidence the surface is wrongly modeled as autonomous. Downgrade it in `lib/autonomy.yaml`.

The autonomy model fails gracefully: the worst-case edit produces one git commit you revert. The system doesn't depend on the role being right.
