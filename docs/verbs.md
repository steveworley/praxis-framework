# Verbs (Phase 4 placeholder)

A planned taxonomy that lets agents declare what kind of work they do, so the dashboard can group them universally regardless of role.

This is **not yet implemented** in Phase 0. Agent files in Phase 0 don't require frontmatter, and the dashboard groups agents by directory only. This document records the shape so Phase 0 work doesn't paint Phase 4 into a corner.

## The proposed verb set

Universal verbs distilled from observing role behaviors:

| Verb | What it covers | Example agents |
|---|---|---|
| `intake` | Bringing new work into scope | `intake-leads`, `monitor-channels`, `webhook-listener` |
| `research` | Gathering context before deciding | `research`, `enrich`, `lookup` |
| `decide` | Classifying, routing, qualifying | `qualify`, `triage`, `score` |
| `produce` | Generating the work product | `draft-emails`, `write-report`, `compose-reply` |
| `review` | Quality gate before action | `review`, `approve`, `lint` |
| `act` | Executing a side-effecting action | `send-emails`, `create-issue`, `post-to-slack` |
| `monitor` | Watching in-flight work | `monitor`, `check-status`, `tail-logs` |
| `respond` | Handling responses, replies, follow-ups | `respond`, `follow-up`, `bounce-handler` |
| `reflect` | Meta — memory, escalations | `escalate`, `reflect-end-of-run` |

Verbs are recommended, not enforced. Roles that need other verbs can declare them.

## Frontmatter shape (Phase 4)

```yaml
---
verb: produce
when_to_run: ...
inputs: [campaigns/{id}/prospects/{id}.json]
outputs: [campaigns/{id}/prospects/{id}.json with email.body populated]
---
```

The dashboard will read `verb` and group agents into universal columns: "what's queued in `decide`", "what's blocked at `review`", etc. Roles with custom verbs render under a "custom" group.

## Why universal verbs matter

A supervisor running multiple Praxis roles wants to see at a glance: across all my roles, what's queued for review? What's blocked at intake? Verbs make the dashboard cross-role legible.

Until Phase 4, agents are grouped by directory only and supervisors read each role independently.

## Authoring guidance for Phase 0

If you're authoring agents now and want to be Phase 4-ready, add the verb frontmatter today. The Phase 0 dashboard will ignore it; Phase 4 will pick it up automatically.
