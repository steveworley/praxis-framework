# Examples

Praxis is the conventions; the examples here describe how a real role inhabits them.

## Sam Parker — Quant BD agent

The reference implementation. Sam runs sales-side outreach for [Quant](https://quantcdn.io): cold campaigns, manual lead intake, weekly account reads on existing customers. She authenticates as `sam.parker@quantcdn.io` via a workspace MCP server.

Sam's repo is [`quantcdn/sam`](https://github.com/quantcdn/sam) (private). What Praxis distilled from observing her in operation:

| Convention | What Sam does |
|---|---|
| `agents/` | 18+ playbook files: discover, research, find-contacts, draft-emails, review, send-emails, monitor, respond, follow-up, post-meeting, bounce-handler, tender-watch, intake-leads, account-read, monitor-channels, slack-triage, summary-campaign, summary-daily, escalate |
| `lib/` | `customers.yaml`, `team.yaml`, `compliance.yaml`, `quant-capabilities.yaml`, `research-strategies.yaml`, `intake-channels.yaml` |
| `memory/` | People (Stu, Con, Steve), accounts (per-customer narrative), notes (voice calibrations, observed patterns) |
| `escalations/` | Help / improvement / proposed_skill — gated review by Steve |
| Work product | `campaigns/{id}/` — each cold campaign is a directory with prospects, logs, templates, and config |

### What Praxis kept and what it didn't

**Kept (universal):**
- The four-directory shape (`agents/`, `lib/`, `memory/`, `escalations/`)
- The persona file convention with parseable Identity / Voice / Capabilities / Inhibitions sections
- The escalation kinds (`help`, `improvement`, `proposed_skill`)
- The skill-loop acceptance gate (operator owns moves from `proposed/` to `agents/`)
- Memory rules (don't shadow structured files, timestamp everything)
- The end-of-run / on-surprise reflection triggers

**Specific to Sam (not in the framework):**
- Pipeline shape (discover → research → find-contacts → draft → review → send → monitor → respond)
- Customer / prospect / campaign vocabulary
- IRAP compliance hard rules
- Slack channel monitoring shape
- Gmail/Calendar integrations

The framework provides the scaffolding; each role authors its own pipeline, vocabulary, and integrations.

## Hypothetical roles a Praxis user might build

Not implemented — illustrative.

- **Triage agent** — watches an inbox / GitHub issues / Linear; classifies and routes. Work product: `tickets/`.
- **Research assistant** — runs literature searches, drafts briefs, tracks open questions. Work product: `investigations/`.
- **CSM observer** — reads customer signal (support, calls, NPS), writes account reads, surfaces churn risk. Work product: `accounts/` with weekly reads.
- **Build watcher** — monitors CI, classifies failures, files issues. Work product: `incidents/`.

Each one would:
1. Author a `persona.md` for the role
2. Author a `CLAUDE.md` operating manual
3. Add domain-specific agents under `agents/`
4. Populate `lib/` with reference data
5. Pick a work-product directory name that fits

The framework's dashboard works for all of them out of the box.
