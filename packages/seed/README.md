# @praxis-framework/seed

Role-scaffolding library that powers [`@praxis-framework/cli`](https://www.npmjs.com/package/@praxis-framework/cli)'s `init` command.

Given a validated role definition, `seedRole()` writes a populated [praxis-framework](https://github.com/steveworley/praxis-framework) role into a target directory: `persona.md`, `CLAUDE.md`, `verbs/`, `lib/`, `memory/`, `escalations/`, and `output/`.

## Who should use this

Most operators should reach for [`@praxis-framework/cli`](https://www.npmjs.com/package/@praxis-framework/cli) instead — it wraps this library in an interactive wizard and handles input collection, validation feedback, and git integration. The CLI is the supported entry point.

This package is published separately so the framework's dashboard can also call `seedRole()` directly from its in-browser setup flow. If you're building tooling on top of praxis and need programmatic scaffolding, import from here. Otherwise use the CLI.

## Install

```bash
npm install @praxis-framework/seed
```

## Usage

```ts
import { seedRole, type SeedInput } from '@praxis-framework/seed';

const input: SeedInput = {
  organisation: { name: 'Acme', size: 'small' },
  role_definition: {
    role_name: 'sales-lead',
    one_sentence_purpose: 'drives outbound on Acme\'s flagship product',
  },
  voice_traits: [{ trait: 'direct', qualifiers: ['short sentences, no hedging'] }],
  capabilities: ['drafts cold-outreach emails'],
  inhibitions: ['never quote prices without sign-off'],
  initial_verbs: [{ slug: 'draft-cold-emails', description: ['compose an outreach email per prospect'] }],
  tools: [],
};

const result = await seedRole(input, '/path/to/new-role');
console.log(result.filesWritten);
```

`SeedInput` is validated with Zod; invalid input throws `SeedError` with `code: 'INVALID_INPUT'`. Refer to the source in [`src/types.ts`](./src/types.ts) for the full schema.

## License

MIT — see [LICENSE](https://github.com/steveworley/praxis-framework/blob/main/LICENSE).
