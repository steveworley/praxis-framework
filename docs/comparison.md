# Comparison: praxis vs self-improving agents

Most agent frameworks today fall into two rough shapes. *Self-improving agents* rewrite their own playbook based on outcomes — a feedback loop closes between observation and behavior change without a human in the middle. *Workflow engines* compose tool calls into directed graphs and don't really "grow" at all; the graph is the program. Praxis sits in neither camp. This doc lays out where praxis fits, what it gives up, and what it gets in exchange.

The foil throughout is what praxis's own docs already call "Hermes-class" — the broad category of agents that self-modify behavior in response to outcomes. The label is shorthand for a shape, not a specific product.

## What praxis is

Praxis is a framework for **role-based agents that grow into a defined role**. The role is the unit of evolution, not the agent. Voice, hard rules, capabilities, and reference data are authored up front — they're the role's constitution — and the agent grows *within* those bounds.

The agent gets three places to grow on its own:

1. **Memory** — observational, persona-shaped notes the role writes about people, situations, and patterns it sees. Free-form. The role owns relevance.
2. **Escalations** — structured asks (`help`, `improvement`, `proposed_skill`). The role raises its hand; the operator triages.
3. **Drafts of new skills** — proposed verb playbooks land in `verbs/proposed/`. The operator accepts or declines via the dashboard's triage surface.

Plus a fourth, opt-in surface: **bounded autonomous edits to operator-opened files** (`lib/research-strategies.yaml`, `lib/team.yaml`, `lib/warmup.yaml`, etc.) under one of three modes — `append-only`, `inline-enrichment`, `bounded`. The operator declares what's open in `lib/autonomy.yaml`. Everything else is gated by default.

Constitutional surfaces — `persona.md`, live `verbs/*.md`, `lib/customers.yaml`, `lib/compliance.yaml`, `lib/autonomy.yaml`, `CLAUDE.md` — stay gated forever. They're the role's identity; the line is "the role doesn't edit its own constitution."

This isn't no-self-modification. It's *differentiated* self-modification: matched to risk per surface, not to time-in-role.

## What self-improving agents do differently

A self-improving agent closes the loop between outcome and behavior. It observes (a campaign performed well, an objection pattern recurred, a deal closed faster than expected) and then *mutates its own playbook* — fine-tunes weights, edits prompts, rewrites strategies, accumulates vector-embedded "lessons" — without an operator in the middle.

The shape has real strengths. Iteration is fast. Improvements compound without manager bottleneck. Routine optimizations don't need approval. For sandboxed problems with clear success metrics, the loop closes tightly.

It also has real costs:

- **The constitution drifts.** Voice, hard rules, and identity all live in the same mutable substrate as the tactical playbook. Small mutations accumulate; the agent at month six is not the agent at month one.
- **Audit is hard.** When the agent's behavior lives in weights or in vector-store retrieval rankings, "why did it do that?" is a research question, not a `git log`.
- **Bad mutations are hard to revert.** If a fine-tune step shifted the agent's tone, you can't `git revert` a tone shift. Sometimes you can roll back to a checkpoint; often the simpler answer is to retrain.
- **Predictability degrades.** The operator's mental model of "what this agent will do next" weakens as the agent learns. For brand-sensitive or compliance-bound work, that's a problem.

Praxis is the answer to "what if the constitution stayed explicit and the growth stayed visible?"

## Feature-by-feature

| Dimension | Praxis | Self-improving (Hermes-class) |
|---|---|---|
| **Capability change path** | Role drafts to `verbs/proposed/<slug>.md`; operator accepts/declines via `/triage`. Two-step, human-in-the-loop, ungraduated. | Agent mutates its own playbook based on outcomes. No intermediate gate. |
| **Constitution stability** | `persona.md` + hard rules + `lib/customers.yaml` + `lib/compliance.yaml` + `CLAUDE.md` are hard-coded as constitutional (`autonomy-gate.ts` refuses even when `autonomy.yaml` is malformed). | Constitution and tactics share substrate; both drift. |
| **Autonomy model** | Differentiated per surface, four modes (`full`, `append-only`, `inline-enrichment`, `bounded`), operator-declared in `lib/autonomy.yaml`. | Usually a single global "self-improvement" loop. |
| **Audit trail** | Every dashboard-mediated edit is a git commit signed by `Praxis Role <role@praxis.local>` (role-side) or the operator (triage-side). `git log --author=Praxis` recovers every autonomous edit. | Behavior changes embedded in weights or retrieval state. No comparable command. |
| **Memory shape** | Markdown files under `memory/{people,accounts,notes}/<slug>.md`. Grep-able, diff-able, hand-editable. | Often vector-embedded; opaque to human inspection. |
| **Runtime model** | Two runtimes consuming the same role files — Claude Code on the host for technical operators; `/chat` (Anthropic SDK) for non-technical operators. The chat exposes 9 typed tools (`write_memory`, `create_escalation`, `propose_verb`, `append_entry`, `enrich_entry`, `adjust_param`, `write_output`, `update_output_status`, `log_decision`). | Typically one runtime, agent-shaped, with self-modification baked in. |
| **Persona drift** | Persona is a file. The chat surface refuses to write to it; the only path is operator-driven co-authoring under `/triage/draft/<id>`. | Persona is whatever the weights/state currently say. |
| **Reversibility of growth** | `git revert <sha>` on any autonomous commit. Worst-case is one bad markdown entry on one known path. | Depends on the architecture. Often re-train or roll back to checkpoint. |
| **Cross-role learning** | None as a framework primitive. Each role is its own directory; no shared memory pool. | Sometimes available via shared vector store or shared base model. |
| **Growth visibility for the supervisor** | A dashboard reads the role's directory and surfaces persona, memory, escalations, recent edits, output, triage queue, and decision logs. Everything visible is a file. | Some surfaces (logs, traces) are visible; the actual mutation usually isn't. |

## Where praxis improves itself today

Praxis is not a no-autonomy framework. Within the operator's declared bounds, the role does change things on its own — visibly, in commits attributed to the role, on paths the operator opened. Concretely, the four shipped autonomy modes:

**`full` — the role's own working surfaces.** `memory/`, `escalations/`, `verbs/proposed/`, `logs/`, and `output/` are implicitly autonomous (see `IMPLICIT_AUTONOMOUS_PREFIXES` in `dashboard/src/lib/chat/autonomy-gate.ts`). Example: after a conversation where the role notices that a contact prefers morning calls, it calls `write_memory({category: "people", title: "Mary at Acme — comms preferences", body: ...})`. The file lands at `memory/people/mary-at-acme-comms-preferences.md`. The dashboard renders it. The supervisor reads it like a manager reviewing a direct report's notes.

**`append-only` — operator-opened lists.** The role can add new entries to a declared list but can't edit or delete existing ones. Example: `lib/research-strategies.yaml` with `mode: append-only, max_pending: 5`. The role notices that AU TAFE org leadership pages sit at `/about/leadership` and calls `append_entry({path, entry: {id, pattern, observed, confidence}})`. A `reviewed: false` marker is injected automatically. When 5 unreviewed entries accumulate, the next append refuses with a clear message — the role's expected response is to file an `improvement` escalation asking for compaction.

**`inline-enrichment` — operator-owned structure, role-owned texture.** The role can update declared soft fields within existing entries but never adds or removes entries. Example: `lib/team.yaml` with `soft_fields: [notes, last_observed_at]`. The role calls `enrich_entry({path, entry_id: "steve", soft_fields: {notes: "morning person, pings via Slack for urgent items"}})`. Hard fields (`name`, `role`, `email`) are operator-owned and refused.

**`bounded` — operator-set bands, role tunes within.** Example: `lib/warmup.yaml` with `bounds: {sends_per_day: {min: 10, max: 100, step: 5}}`. The role observes deliverability and calls `adjust_param({path, key: "sends_per_day", value: 30})`. Values outside the band, off-step, or against an undeclared key are refused with a message naming the violated bound.

Beyond these four, the **co-authoring path** ships under `/triage/draft/<id>`. When an `improvement` escalation lands on a constitutional surface (e.g. *"my voice is too formal for engineering contacts"*), the operator can pick a target (`persona.md`, `CLAUDE.md`, a live verb, a `lib/*` file), write a directive, see the model's full proposed file, review the unified diff, edit inline, then **Apply**. The commit is attributed to the operator with a `Co-Authored-By: Praxis Role <role@praxis.local>` trailer (see `dashboard/src/lib/coauthor/index.ts`). Targets are a closed enum; path traversal is refused at the resolver and the apply boundary; frontmatter preservation is enforced. This is not graduation of autonomy — the role's autonomous toolset is unchanged. It's a faster operator workflow for asks the role surfaced.

And the things that stay gated forever, regardless of `autonomy.yaml`:

- `persona.md` — identity.
- `CLAUDE.md` — operating manual; behavior drift would cascade across all verbs.
- `verbs/*.md` (live, not `proposed/`) — accepted playbooks. New behavior goes through `verbs/proposed/` + an escalation.
- `lib/customers.yaml`, `lib/compliance.yaml` — legal/business risk surfaces.
- `lib/autonomy.yaml` itself — the role cannot expand its own autonomy.
- `lib/tools.yaml` — the role's capability catalog.

The hard-coded list lives in `CONSTITUTIONAL_PATHS` in `autonomy-gate.ts` and is enforced before the yaml is even read, so a malformed `autonomy.yaml` cannot accidentally open a constitutional surface.

## Trade-offs

Praxis is slower to evolve than a self-improving agent. That's the trade.

- **Capability changes take a manager loop.** The role drafts a verb; the operator reviews and accepts. A self-improving agent skips the loop. If a role is iterating on its own tactics 50 times a week, the operator triage cost is real.
- **The growth ceiling is bounded by what the operator opens.** A surface that the operator never adds to `lib/autonomy.yaml` stays gated forever. Roles whose work genuinely depends on widening autonomy past the operator's available review bandwidth will hit a ceiling.
- **The operator stays in the loop on the constitutional surfaces.** Persona, hard rules, live verbs, customer/compliance data — these don't change without an operator-mediated commit. If the operator is unavailable, the role can't refine its voice on its own.

In exchange:

- **Predictability stays high.** The role at month six is recognizably the role at month one — voice intact, hard rules intact, capabilities expanded only through accepted drafts.
- **Audit is `git log`.** Every autonomous edit is one commit, on a known path, attributed to a stable synthetic actor. `git log --author=Praxis` and `git log --grep='Co-Authored-By: Praxis Role'` are the two audit lenses.
- **Bad edits are one revert away.** Worst-case autonomous mutation is one markdown entry; `git revert <sha>` undoes it. If the same shape of edit keeps getting reverted, that's signal — the operator downgrades the surface in `autonomy.yaml`.
- **The constitution doesn't drift.** It's a file. It's read on every chat turn and every Claude Code session. Changes to it are visible commits with a `Co-Authored-By` trailer.

Neither framework is better in the absolute. Self-improving agents iterate faster on routine improvements at the cost of unbounded drift and harder audit. Praxis evolves at operator-pace at the cost of being slower to optimize within the role's lane.

## When to choose which

- **Customer-facing, brand-sensitive, voice-load-bearing work.** Praxis. Predictability of voice and identity matters more than rate of improvement. The wrong tonal drift can damage trust faster than fast iteration can recover it. Sam, the reference role in `examples/`, sits here — a BD agent representing Quant has a brand to honor.
- **Regulatory or compliance-audit contexts.** Praxis. Every behavioral change is a git commit attributed to either the role or the operator. Auditors want "show me every change to your agent's behavior in Q1" answered by a one-liner, not a research project.
- **Internal research, sandboxed exploration, no human-facing brand at stake.** A self-improving agent might iterate faster. If the loss function is well-defined and bad mutations hurt only the experiment, the audit overhead of praxis is paying for safety the project doesn't need.
- **Pure software-agent tasks that don't touch identity** — e.g., an agent that triages GitHub issues by reading templates and applying labels. Either framework works. Praxis's audit story is cheap to keep; the self-improving loop's drift risk is also low because there's no persona to drift.
- **Multi-role suites where each role has its own remit.** Praxis. Each role is one directory; cross-role contamination is structurally prevented (no shared memory pool). A self-improving agent shared across roles can have one role's learning leak into another's behavior.

## Implementation reference

The shipped code that grounds this comparison:

- `dashboard/src/lib/chat/tool-schemas.ts` — the 9 chat tools the role has (`write_memory`, `create_escalation`, `propose_verb`, `append_entry`, `enrich_entry`, `adjust_param`, `write_output`, `update_output_status`, `log_decision`).
- `dashboard/src/lib/chat/autonomy-gate.ts` — the hard-coded constitutional list, the implicit-autonomous prefixes, the per-mode dispatch.
- `dashboard/src/lib/coauthor/` — the operator-driven path for applying constitutional changes (`index.ts`, `prompt.ts`, `types.ts`).
- `dashboard/src/lib/audit.ts` and the conventional-commit shapes documented in `docs/dashboard.md` § Audit trail.
- `docs/autonomy.md` — the four modes in full, with `autonomy.yaml` examples per mode.
- `docs/philosophy.md` — the role-based-growth thesis.

## What praxis explicitly is not

- **Not a multi-agent orchestration framework.** One role, one directory, one runtime at a time. Multi-role means multiple framework clones.
- **Not a memory database.** Memory is markdown. Search is grep until it isn't.
- **Not a workflow engine.** Verbs are markdown prompts an LLM executes, not a DAG. Composition is up to the role-author.
- **Not graduated trust over time.** The role doesn't "level up" autonomy by accumulating successful edits. Autonomy is per-surface and operator-controlled, declared in `lib/autonomy.yaml`. To widen it, the operator edits the yaml.
- **Not Hermes.** The role doesn't self-modify behavior based on outcomes. Capability changes go through human-in-the-loop acceptance via `verbs/proposed/`. The autonomous surfaces are additive observations and bounded operational tuning, not behavioral mutations.
