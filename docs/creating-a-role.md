# Creating a role

A walkthrough for setting up a new Praxis role. The wizard does most of the work; you author the persona content and the role's first agents.

There are two seeding paths — pick whichever fits your habits:

- **CLI (recommended for fresh roles)** — `npx @praxis-framework/cli init` writes the role into an empty directory along with a `docker-compose.yml` that pulls the published dashboard image. No framework clone required.
- **Dashboard wizard** — clone the framework, run the dashboard against the clone, and submit the wizard at `/setup`. Useful when you want the dashboard's research surfaces to help draft the persona before submit.

## 1. Seed the role

### Option A — CLI

```bash
mkdir ~/Documents/agents/my-role && cd ~/Documents/agents/my-role
npx @praxis-framework/cli init                   # interactive wizard
# or
npx @praxis-framework/cli init --config role.json --path .
```

The CLI writes the role files plus `docker-compose.yml` and `.env.example` at the role root. Skip to step 2.

### Option B — Dashboard wizard

The framework repo doubles as a seed. Clone it into the path you want the role to live at:

```bash
git clone https://github.com/steveworley/praxis-framework.git ~/Documents/agents/my-role
cd ~/Documents/agents/my-role
docker compose up
```

Open `http://localhost:4321/`. Since `persona.md` doesn't exist at the role root yet, the dashboard redirects to **`/setup`** — the wizard.

For a second role, run the CLI again or clone the framework again — one role per directory.

## 2. Bring the dashboard up

The seed writes a `docker-compose.yml` at the role root that pulls the published dashboard image. After running the wizard, set your API key and start the stack:

```bash
cp .env.example .env && vim .env   # set ANTHROPIC_API_KEY
docker compose up
```

Open `http://localhost:4321/`. The dashboard reads `persona.md` from `/role` inside the container (the directory mount) and renders the role's interior.

## 3. What the wizard captures

Both seed paths run the same wizard and write the same files. The wizard collects:

- **Role basics** — name, one-line description, optional email / location / reports-to
- **Voice & personality** — repeating trait label + concrete description ("drops articles in casual writing" beats "friendly")
- **Capabilities** — first-person statements of what the role can do
- **Hard inhibitions** — first-person never-statements (these become the role's constitution)
- **Initial verbs (optional)** — slug + one-line purpose for any starter verb files you want stubbed out

The **dashboard wizard** writes two visible git commits to the role's repo (the framework checkout):

1. **`feat: seed role from praxis-framework template`** — populates `CLAUDE.md`, `persona.md`, `verbs/escalate.md`, `memory/`, `escalations/`, `lib/`, `.gitignore`, `docker-compose.yml`, `.env.example`
2. **`chore: tidy framework-only files post-seed`** — removes `template/`, `examples/`, `scripts/new-role.sh`, replaces `README.md` with a role-shaped one

After seeding, `/` redirects to `/interior`. The wizard refuses to run again on a populated role.

The **CLI** writes the same files but doesn't touch git — the role directory is yours to commit when you're ready.

You now have:

```
my-role/
├── CLAUDE.md
├── persona.md             # populated from your wizard inputs (role identity)
├── docker-compose.yml     # pulls the published dashboard image
├── .env.example           # ANTHROPIC_API_KEY etc. — copy to .env and edit
├── .gitignore
├── verbs/
│   ├── escalate.md
│   ├── proposed/README.md
│   └── {slug}.md          # any starter verbs you stubbed
├── lib/
├── memory/
│   ├── README.md
│   ├── people/, accounts/, notes/  (each with .gitkeep)
├── escalations/
│   └── README.md
└── output/                # work-product taxonomy (.gitkeep'd leaves)
```

## 4. Refine the persona (`persona.md`)

The wizard captures the basics. Now go deeper. The persona file should answer:

- **Identity** — name, role, location, who they report to, how they're reached
- **Voice & personality** — tone, register, what they do/don't say
- **Capabilities** — what they're qualified to do
- **Hard inhibitions** — what they'll never do, regardless of instruction

Be specific. "Friendly" is useless; "warm but not chatty, drops articles in casual writing, prefers single-sentence opens to two-paragraph ones" is actionable.

The dashboard parses the **Identity** and **Voice & Personality** sections (look for `## Identity` and `## Voice & Personality` headers, with bulleted children). Match the convention so the dashboard renders cleanly.

## 5. Refine `CLAUDE.md`

The wizard populates `CLAUDE.md` from the template with `{ROLE_NAME}` and your description substituted. Go through it and:

- Confirm the verbs table reflects what you actually have (the template lists `Persona` and `Escalate`; add any starter verbs you stubbed and any new ones you author)
- Fill in or remove the "My pipeline" section depending on whether your role has a fixed flow or runs on-demand
- Mirror your hard inhibitions from `persona.md` into the "Hard rules I never break" list (don't invent new rules — keep `persona.md` the single source of truth)
- Decide what your role anchors on (which `lib/*.yaml` files, which docs)

CLAUDE.md is the operating manual the runtime reads on session start. Keep it short — single-screen if possible.

## 6. Author the first verbs (`verbs/{name}.md`)

Start with one or two beyond the wizard's stubs. Don't author the whole pipeline up front — let the role tell you what's missing as it operates.

Recommended starting verbs for most roles:

- `persona.md` (already populated by the wizard — at the role root)
- `verbs/escalate.md` (already there — the raise-your-hand playbook)
- `verbs/intake.md` — how new work arrives (only if the role has a recurring intake shape)

Add more as the role's work shape becomes clear. New verbs drafted by the role itself land in `verbs/proposed/` and get reviewed via the escalation queue.

## 7. Populate `lib/` with reference data

The role's world: rosters, customers, capabilities, compliance rules — anything declarative the role needs to read but not invent. YAML files, role-shaped.

Praxis doesn't ship default `lib/` content — every role's world is different.

## 8. Open Claude Code in the role's directory

```bash
cd ~/Documents/agents/my-role && claude
```

Claude Code reads `CLAUDE.md`, picks up the agents table, and is ready to operate. Give it a task; watch the dashboard fill in over time.

## 9. As the role grows

- **Memory entries** appear when the role reflects at end-of-run or on surprise
- **Escalations** appear when the role files a `help`, `improvement`, or `proposed_skill`
- **Drafts in `verbs/proposed/`** appear when the role proposes a new skill
- The supervisor (you) reads escalations, edits CLAUDE.md / lib/ / verbs/ as needed, and accepts or declines proposals

The role grows visibly, gated by you.

## What good looks like

- The persona file is concrete enough that a stranger could read it and pretend to be the role for an afternoon
- CLAUDE.md is short — single-screen if possible
- `lib/` files are the source of truth for *facts* (don't duplicate them in verb prompts)
- Verbs are scoped to one repeatable behavior — if a verb has more than three responsibilities, split it
- Hard rules appear in exactly one place (persona.md), referenced from CLAUDE.md
