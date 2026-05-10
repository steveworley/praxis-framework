# Caro — proposed second role

**Status**: idea, not built. Captured 2026-05-08 from a conversation about what shape a second praxis-framework role should take.

## TL;DR

A Customer Renewal & Account Operator (working name "Caro") — Quant CSM agent. Complement to Sam: where Sam *acquires* customers, Caro *keeps and grows* them. Builds on the same praxis primitives but stresses dimensions Sam doesn't.

## Why this role

Two tests we want the framework to pass:

1. **Same primitives, different shape** — Sam is BD-shaped (episodic, persona-led, mostly solo, external-facing). The framework should handle a CSM-shaped role too (durative, persona-different, inter-role-coordinated, mostly internal-facing). If both work without rebuilding the framework, that's the generalisability claim.
2. **Real production work** — Sam exists in production. A second toy role wouldn't add empirical signal. Caro would be a real Quant agent doing real renewal/expansion work.

## Where this stresses the framework

| Dimension | Sam (BD) | Caro (CSM) | What it tests |
|---|---|---|---|
| Cadence | Episodic (per campaign, per prospect) | Durative (per account, per year) | Long-running relationship work |
| Persona | Curious technical matchmaker | Patient, operational, inside-baseball | Voice DSL flexes to a different tone |
| Voice surface | External cold outreach | Mostly internal (Slack to Con/Steve), occasionally external | Audience switching |
| Memory shape | Per-prospect, ~50 active | Per-account × multi-year horizon | Memory longitudinality |
| Work-product unit | `campaigns/{id}/` | `accounts/{domain}/` | Whether `campaigns/` convention generalises or needs a `<unit>/` abstraction |
| Decisions | Categorical (which contact, which angle) | Temporal (when to escalate, is this churn risk) | Decisions primitive on temporal judgment |
| Inter-role coordination | Mostly solo | Receives signals from Sam, routes to Steve/Stu/Con | Tests the inter-role primitives we haven't built yet |

The honest read: Sam is the easy case for the framework. Caro is harder. If the primitives work for both, the framework's claim is real.

## Caro's shape, sketched

### Identity
```
Full name: Caro Reyes (or whatever name lands — pair with Steve)
Role: Customer Renewal & Account Operator, Quant
Reports to: Con Fountas (Customer Engagement Director)
Email: caro.reyes@quantcdn.io
Voice: experienced, patient, attuned to long-running dynamics. Operational
       not chatty. Knows the customer roster cold. Writes "I noticed X
       drift" not "I'm reaching out to confirm".
```

### Hard inhibitions (different from Sam's)
- Never makes pricing promises
- Never closes a renewal — surfaces it for Con to handle
- Never sends a customer-facing message without explicit operator approval (higher gate than Sam — these are paying customers)
- Never characterises a customer's posture in writing without naming the signal that produced the read

### Loop
- **Weekly**: read each active customer's recent state (CDN usage, support tickets, Slack mentions from Sam's `monitor-channels`, last touch from Con). Surface health changes.
- **Monthly**: report on upcoming renewals (90 / 60 / 30 day windows) with `needs Con's attention` / `on track` / `at risk` classification.
- **Quarterly**: write a customer health narrative that Con uses as a briefing.
- **Ad-hoc**: when Sam's `monitor-channels` flags an existing customer in `#dash-notifications` etc., Caro picks it up, contextualises against the account history, surfaces whether it's expansion signal vs. noise.

### Primitives — how each one stretches

- **`verbs/`** — different verbs: `account-read`, `renewal-watch`, `health-narrative`, `expansion-signal-classifier`, `briefing-draft`, `escalate-to-con`. Probably 6-8 playbooks total — smaller than Sam's 23.
- **`lib/`** — overlaps with Sam (`customers.yaml`, `team.yaml`, `compliance.yaml`) plus new: `renewal-cadence.yaml`, `health-signals.yaml`, `escalation-routing.yaml` (when does it go to Con vs Stu vs Steve).
- **`memory/`** — heaviest stretch. Per-customer files (`memory/accounts/{domain}.md`), per-contact files (`memory/people/{slug}.md`), and a new dimension: per-account-per-period (`memory/accounts/{domain}/2026-h1.md`) for narrative arcs.
- **`escalations/`** — different shape. Sam's escalations are mostly process. Caro's are situational ("Library Victoria's pageviews dropped 40% week-over-week, recommend Con check in").
- **Work product** — `accounts/{domain}.json` (the long-discussed account-curator output) + `accounts/{domain}/reads/{date}.md` weekly narratives + `accounts/{domain}/health/{date}.jsonl` health-signal log.
- **Decisions** — different `decision_type` values: `health_classification`, `renewal_risk`, `escalation_routing`, `expansion_vs_noise`. Tests whether the primitive vocabulary generalises beyond Sam's.
- **Autonomy** — likely opens different surfaces: `lib/health-signals.yaml` as `append-only` (Caro discovers new signal patterns), maybe `lib/renewal-cadence.yaml` as `bounded` (within operator-set ranges).


### Relationship to existing roadmap items

`~/Documents/quant/sam-dashboard/planned-agents/account-curator.md` describes a CRM-side data layer agent — writes `lib/accounts/{domain}.json` files, no persona, no customer-facing voice. Pure data layer.

Caro is the *actor* on top of that data layer. Curator writes the JSON; Caro reads it, contextualises it, and acts. Two complementary roles.

For an MVP Caro could skip Curator and read raw signals directly (customers.yaml + manual-leads prospects + Slack signal). Adds to her load, but means we don't have to build two new roles to test the framework.

## What the research piece gains

- **Two roles, same primitives, different shapes** → "the framework handles episodic outbound and durative account management with the same four growth surfaces"
- **Persona DSL flexes** → "voice and inhibitions scale to genuinely different operational tones without rebuild"
- **Inter-role signal handoff** → maybe surfaces the need for a fifth primitive (cross-role messaging), and that discovery itself becomes part of the piece
- **Memory longitudinality** → if Caro's memory works across multi-year arcs without becoming useless, that's a strong claim against vector-embedding-based memory. If it doesn't, that's an honest limitation worth documenting.
- **Side-by-side empirical comparison** → decision rates, escalation distributions, autonomous-edit revert ratios across two roles is more interesting than one role's data alone.

## When to build

Not now — Sam's still maturing (the autonomy + decisions primitives just landed and need to earn their keep with her). When Caro gets built, she should be a vehicle for the research piece, not just another pipeline to maintain.

Trigger: when Sam's instrumentation has produced ~4 weeks of data (decision logs, escalation queue, autonomous edits, memory writes) and the patterns are clear enough that we know what to *measure* in Caro's run-up.

## Open questions to resolve before building

- Does Caro's work-product directory follow the `campaigns/{id}/` convention or do we formalise a `<unit>/{id}/` abstraction in the framework first?
- How does the inter-role signal handoff work? Sam's `monitor-channels` writes to a shared spot Caro reads? File-based queue? Slack-mediated?
- Is there a fifth primitive (cross-role memory? shared lib?) we're going to discover by trying?
- Does the dashboard need multi-role support (a role-switcher, or one dashboard per role)? The current model is "one praxis repo per role"; multi-role = multiple clones. Caro would clarify whether that's the right call.

## Alternative we considered: not a Quant role

Building outside Quant (open-source maintainer agent, regulatory researcher, incident responder) would prove cross-org generalisability — but you wouldn't run any of them in production, so the empirical bar drops. A toy role is just a thought experiment with extra steps. Caro's value is that she'd be real.

---

Move this to `docs/` proper (drop the `future/` prefix) when Caro becomes the next role to build.
