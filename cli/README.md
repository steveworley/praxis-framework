# @praxis-framework/cli

Operator CLI for the [praxis-framework](https://github.com/steveworley/praxis-framework). Scaffolds a populated agent role from interactive prompts (or a JSON config), ready to drop into a compose stack.

## Install

```bash
npm install -g @praxis-framework/cli
```

Requires Node.js 20 or newer.

## Quick start

```bash
mkdir my-role && cd my-role

# Interactive wizard — walks organisation context, role definition,
# voice traits, capabilities, inhibitions, and verbs.
npx @praxis-framework/cli init

# Or hand it a config file (useful for CI / reproducible setups).
npx @praxis-framework/cli init --config role.json --path .

# Set your API key and bring the dashboard up.
cp .env.example .env && vim .env   # set ANTHROPIC_API_KEY
docker compose up                   # pulls ghcr.io/steveworley/praxis-framework/dashboard:main
```

Open `http://localhost:4321/`.

The wizard emits a populated role directory with `persona.md`, `CLAUDE.md`, `verbs/`, `lib/`, `memory/`, `escalations/`, `output/`, plus `docker-compose.yml` + `.env.example` so the role is runnable with one `docker compose up` — no framework clone required. See `examples/sample-role.json` for the config schema.

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
