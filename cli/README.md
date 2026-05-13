# @praxis-framework/cli

Operator CLI for the [praxis-framework](https://github.com/steveworley/praxis-framework) — the fastest way to seed a new role and bring the dashboard up.

## Quick start

```bash
mkdir my-role && cd my-role

# Walk the interactive wizard.
npx @praxis-framework/cli@latest init

# Or hand it a config file (useful for CI / reproducible setups).
npx @praxis-framework/cli@latest init --config role.json --path .

# Set your API key and bring the dashboard up.
cp .env.example .env && vim .env   # set ANTHROPIC_API_KEY
docker compose up                   # pulls ghcr.io/steveworley/praxis-framework/dashboard:main
```

Open `http://localhost:4321/`. The dashboard is your primary surface — `/chat` to operate the role, `/triage` to review what it raises, `/role` to inspect the constitution.

The CLI emits a populated role directory with `persona.md`, `CLAUDE.md`, `verbs/`, `lib/`, `memory/`, `escalations/`, `output/`, plus `docker-compose.yml` + `.env.example` so the role is runnable with one `docker compose up` — no framework clone required. The seed auto-initialises the target as a git repo on `main`, so you can run `init` against a freshly-`mkdir`'d empty dir without pre-running `git init`. Commits are left for you to make when you're ready. See `examples/sample-role.json` for the config schema.

## Install

If you'd rather pin the CLI globally instead of going through `npx`:

```bash
npm install -g @praxis-framework/cli
```

Requires Node.js 20 or newer.

## Commands

| Command | Purpose |
|---------|---------|
| `praxis init` | Walk the wizard and write a new role into the target path. |
| `praxis init --config <file>` | Skip the wizard and seed from a JSON role definition. |
| `praxis init --path <dir>` | Target directory for the seeded role (default: current directory). |
| `praxis log` | Append a structured log entry to the active role's runtime log. |

## Docs

- [Framework overview](https://github.com/steveworley/praxis-framework#readme)
- [Creating a role](https://github.com/steveworley/praxis-framework/blob/main/docs/creating-a-role.md)
- [Sample role config](https://github.com/steveworley/praxis-framework/blob/main/cli/examples/sample-role.json)

## License

MIT — see [LICENSE](https://github.com/steveworley/praxis-framework/blob/main/LICENSE).
