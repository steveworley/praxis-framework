# Creating a role

A walkthrough for setting up a new Praxis role. The wizard does most of the work; you author the persona content and the role's first agents.

## 1. Clone the framework

The framework repo *is* the seed. Clone it into the path you want the role to live at:

```bash
git clone https://github.com/steveworley/praxis-framework.git ~/Documents/agents/my-role
cd ~/Documents/agents/my-role
```

For a second role, clone again into a different path. The framework doesn't supervise multiple roles — multi-role means multiple clones.

## 2. Run the dashboard

```bash
cd dashboard
npm install
npm run dev
```

Open `http://localhost:4321/`. Since `agents/persona.md` doesn't exist at the role root yet, the dashboard redirects to **`/setup`** — the wizard.

## 3. Walk through the wizard

The wizard is the role-planning UX. It collects:

- **Role basics** — name, one-line description, optional email / location / reports-to
- **Voice & personality** — repeating trait label + concrete description ("drops articles in casual writing" beats "friendly")
- **Capabilities** — first-person statements of what the role can do
- **Hard inhibitions** — first-person never-statements (these become the role's constitution)
- **Initial agents (optional)** — slug + one-line purpose for any starter agent files you want stubbed out

On submit the wizard writes two visible git commits to the role's repo:

1. **`feat: seed role from praxis-framework template`** — populates `CLAUDE.md`, `agents/persona.md`, `agents/escalate.md`, `memory/`, `escalations/`, `lib/`, `.gitignore`
2. **`chore: tidy framework-only files post-seed`** — removes `template/`, `examples/`, `scripts/new-role.sh`, replaces `README.md` with a role-shaped one

After seeding, `/` redirects to `/interior`. The wizard refuses to run again on a populated role.

You now have:

```
my-role/
├── CLAUDE.md
├── README.md            # role-shaped, replaced from the framework's
├── agents/
│   ├── persona.md       # populated from your wizard inputs
│   ├── escalate.md
│   ├── proposed/README.md
│   └── {slug}.md        # any starter agents you stubbed
├── lib/
├── memory/
│   ├── README.md
│   ├── people/, accounts/, notes/  (each with .gitkeep)
├── escalations/
│   └── README.md
├── dashboard/           # the role's dashboard, ready to run
├── docs/                # framework docs travel with the role
└── .gitignore
```

## 4. Refine the persona (`agents/persona.md`)

The wizard captures the basics. Now go deeper. The persona file should answer:

- **Identity** — name, role, location, who they report to, how they're reached
- **Voice & personality** — tone, register, what they do/don't say
- **Capabilities** — what they're qualified to do
- **Hard inhibitions** — what they'll never do, regardless of instruction

Be specific. "Friendly" is useless; "warm but not chatty, drops articles in casual writing, prefers single-sentence opens to two-paragraph ones" is actionable.

The dashboard parses the **Identity** and **Voice & Personality** sections (look for `## Identity` and `## Voice & Personality` headers, with bulleted children). Match the convention so the dashboard renders cleanly.

## 5. Refine `CLAUDE.md`

The wizard populates `CLAUDE.md` from the template with `{ROLE_NAME}` and your description substituted. Go through it and:

- Confirm the agents table reflects what you actually have (the template lists `Persona` and `Escalate`; add any starter agents you stubbed and any new ones you author)
- Fill in or remove the "My pipeline" section depending on whether your role has a fixed flow or runs on-demand
- Mirror your hard inhibitions from `agents/persona.md` into the "Hard rules I never break" list (don't invent new rules — keep `persona.md` the single source of truth)
- Decide what your role anchors on (which `lib/*.yaml` files, which docs)

CLAUDE.md is the operating manual the runtime reads on session start. Keep it short — single-screen if possible.

## 6. Author the first agents (`agents/{name}.md`)

Start with one or two beyond the wizard's stubs. Don't author the whole pipeline up front — let the role tell you what's missing as it operates.

Recommended starting agents for most roles:

- `agents/persona.md` (already populated by the wizard)
- `agents/escalate.md` (already there — the raise-your-hand playbook)
- `agents/intake.md` — how new work arrives (only if the role has a recurring intake shape)

Add more as the role's work shape becomes clear. New agents drafted by the role itself land in `agents/proposed/` and get reviewed via the escalation queue.

## 7. Populate `lib/` with reference data

The role's world: rosters, customers, capabilities, compliance rules — anything declarative the role needs to read but not invent. YAML files, role-shaped.

Praxis doesn't ship default `lib/` content — every role's world is different.

## 8. Open Claude Code in the role's directory

```bash
cd ~/Documents/agents/my-role && claude
```

Claude Code reads `CLAUDE.md`, picks up the agents table, and is ready to operate. Give it a task; watch the dashboard fill in over time.

## 9. As the role grows

- **Memory entries** appear when the agent reflects at end-of-run or on surprise
- **Escalations** appear when the agent files a `help`, `improvement`, or `proposed_skill`
- **Drafts in `agents/proposed/`** appear when the agent proposes a new skill
- The supervisor (you) reads escalations, edits CLAUDE.md / lib/ / agents/ as needed, and accepts or declines proposals

The role grows visibly, gated by you.

## What good looks like

- The persona file is concrete enough that a stranger could read it and pretend to be the role for an afternoon
- CLAUDE.md is short — single-screen if possible
- `lib/` files are the source of truth for *facts* (don't duplicate them in agent prompts)
- Agents are scoped to one repeatable behavior — if an agent has more than three responsibilities, split it
- Hard rules appear in exactly one place (persona.md), referenced from CLAUDE.md
