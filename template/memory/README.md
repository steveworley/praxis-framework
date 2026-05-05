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
- My persona definition + voice rules → `agents/persona.md`
- Operator preferences (how my operator wants me to *run*) → harness auto-memory

This directory: relational and observational content with no other home.

Update the `updated` date when I revise an entry. Growth over time is the point.
