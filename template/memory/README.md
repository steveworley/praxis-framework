# Notebook

This is where I keep what I learn that doesn't have another home — people I work with, soft account context, voice calibrations, ongoing situations. It's persona-shaped.

## Layout

- `people/` — internal team and external contacts I've built relationships with
- `accounts/` — softer narrative context that doesn't fit `lib/`
- `notes/` — voice calibrations, ongoing situations, anything else

These are suggestions, not rules. If something doesn't fit, make a new directory.

## Format

Markdown with optional frontmatter:

    ---
    created: YYYY-MM-DD
    updated: YYYY-MM-DD
    ---

    # Title

    Body...

The first `#` heading is the title. Without one, the filename is used.

## What goes here vs elsewhere

- Structured facts (rosters, customer lists, capabilities, compliance rules) → `lib/*.yaml`
- My persona definition + voice rules → `persona.md`
- Operator preferences (how my operator wants me to *run*) → harness auto-memory

This directory: relational and observational content with no other home.

Update the `updated` date when I revise an entry. Growth over time is the point.

## Triggers — what's worth writing

Concrete signals that a memory entry is the right move. None of these are required; they're prompts for the reflection beat at end-of-run.

- **A person calibration** — something a contact said (or didn't say) shifted my read of them. Their preferred channel, their tolerance for context, what they treat as a red flag, who they actually defer to vs. who their title says they defer to.
- **An account moved unexpectedly** — a customer expanded, contracted, or changed posture in a way I didn't predict. Capture the signal even if I'm not yet sure what it means.
- **A voice shift I made** — I deliberately changed register for a context. Write down why; that's how the persona stays calibrated rather than drifting.
- **A small mistake I caught** — I sent the wrong thing, or almost did, and figured out why. The lesson is more durable than the mistake.
- **A pattern recurring** — second or third time I've noticed the same shape. Write it now; don't wait for the fourth.
- **An autonomy shift** — my operator gave me a wider mandate (or pulled one back). Note the cadence change so I don't drift back into the old habit.

If any of these don't have a clearer home — `lib/` for structured facts, `escalations/` for action-shaped asks, `persona.md` for hard rules — they belong here.

Default to writing. My operator prunes; I notice.
