import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePersona, parsePersonaText } from './persona-parser.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-persona-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('parsePersona', () => {
  it('returns empty structures when persona.md is missing', async () => {
    const persona = await parsePersona(tempDir);
    expect(persona).toEqual({
      identity: {},
      voice: [],
      capabilities: [],
      accountabilities: [],
      success_criteria: [],
      inhibitions: [],
      initial_verbs: [],
    });
  });

  it('parses identity, voice, capabilities, and inhibitions', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n- **Role**: CSM agent\n- **Email**: iris@example.com\n\n## Voice & Personality\n\n- **direct** -- prefers single-sentence opens\n- **warm** -- never uses corporate filler\n\n## Capabilities\n\nWhat I can do.\n\n- I can read accounts weekly\n- I can summarise threads\n\n## Hard inhibitions\n\n- I never send emails without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.identity).toEqual({
      full_name: 'Iris Chen',
      role: 'CSM agent',
      email: 'iris@example.com',
    });
    expect(persona.voice).toEqual([
      { trait: 'direct', qualifiers: ['prefers single-sentence opens'] },
      { trait: 'warm', qualifiers: ['never uses corporate filler'] },
    ]);
    expect(persona.capabilities).toEqual(['I can read accounts weekly', 'I can summarise threads']);
    expect(persona.accountabilities).toEqual([]);
    expect(persona.success_criteria).toEqual([]);
    expect(persona.inhibitions).toEqual(['I never send emails without approval']);
    expect(persona.initial_verbs).toEqual([]);
  });

  it('parses accountabilities and success criteria when present', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can read accounts weekly\n\n## Accountabilities\n\nBridges between what I CAN do and what I drive TOWARD.\n\n- I'm responsible for the quality of cold outreach drafts before they reach the operator.\n- I'm responsible for keeping memory entries current within 24h of every prospect touch.\n\n## Success criteria\n\n- Drafts land within ≤2 review cycles before operator sends.\n- Weekly account reads surface ≥1 actionable signal per watched account.\n- No prospect who has opted-out is ever re-touched.\n\n## Hard inhibitions\n\n- I never send emails without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.accountabilities).toEqual([
      "I'm responsible for the quality of cold outreach drafts before they reach the operator.",
      "I'm responsible for keeping memory entries current within 24h of every prospect touch.",
    ]);
    expect(persona.success_criteria).toEqual([
      'Drafts land within ≤2 review cycles before operator sends.',
      'Weekly account reads surface ≥1 actionable signal per watched account.',
      'No prospect who has opted-out is ever re-touched.',
    ]);
  });

  it('parses accountabilities when success criteria is absent (partial)', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can read accounts weekly\n\n## Accountabilities\n\n- I'm responsible for surfacing churn risk early.\n\n## Hard inhibitions\n\n- I never send without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.accountabilities).toEqual([
      "I'm responsible for surfacing churn risk early.",
    ]);
    expect(persona.success_criteria).toEqual([]);
  });

  it('preserves markdown formatting inside bullet items', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can read accounts weekly\n\n## Accountabilities\n\n- I'm responsible for **draft quality** before review.\n- I'm responsible for keeping \`memory/\` current.\n\n## Success criteria\n\n- Drafts land in *≤2* review cycles.\n\n## Hard inhibitions\n\n- I never send without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.accountabilities).toEqual([
      "I'm responsible for **draft quality** before review.",
      "I'm responsible for keeping `memory/` current.",
    ]);
    expect(persona.success_criteria).toEqual([
      'Drafts land in *≤2* review cycles.',
    ]);
  });

  it('parses multi-qualifier traits as nested bullets', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct**\n  - short sentences, no hedging\n  - calls out tradeoffs upfront\n- **curious** -- asks one question per reply\n\n## Capabilities\n\n- I read accounts weekly\n\n## Hard inhibitions\n\n- I never send without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.voice).toEqual([
      {
        trait: 'direct',
        qualifiers: ['short sentences, no hedging', 'calls out tradeoffs upfront'],
      },
      { trait: 'curious', qualifiers: ['asks one question per reply'] },
    ]);
  });
});

describe('parsePersonaText', () => {
  it('parses an Initial verbs section with single-bullet (inline) entries', () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can run weekly account reads\n\n## Hard inhibitions\n\n- I never send without approval\n\n## Initial verbs\n\n- **account-read** -- weekly read of the customer portfolio\n- **thread-summarise** -- pulls a one-paragraph summary from a Slack thread\n\n# Notes for the operator\n\nSources: their pricing page.\n`;
    const persona = parsePersonaText(text);
    expect(persona.initial_verbs).toEqual([
      { slug: 'account-read', description: ['weekly read of the customer portfolio'] },
      {
        slug: 'thread-summarise',
        description: ['pulls a one-paragraph summary from a Slack thread'],
      },
    ]);
    expect(persona.voice).toEqual([
      { trait: 'direct', qualifiers: ['single-sentence opens'] },
    ]);
    expect(persona.capabilities).toEqual(['I can run weekly account reads']);
    expect(persona.inhibitions).toEqual(['I never send without approval']);
  });

  it('parses multi-bullet verb entries as nested bullets', () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I can read accounts\n\n## Hard inhibitions\n\n- I never send without approval\n\n## Initial verbs\n\n- **account-read**\n  - weekly read of the customer portfolio\n  - flags churn risk and upsell signals\n- **bare-verb**\n- **thread-summarise** -- pulls a one-paragraph summary\n`;
    const persona = parsePersonaText(text);
    expect(persona.initial_verbs).toEqual([
      {
        slug: 'account-read',
        description: [
          'weekly read of the customer portfolio',
          'flags churn risk and upsell signals',
        ],
      },
      { slug: 'bare-verb', description: [] },
      { slug: 'thread-summarise', description: ['pulls a one-paragraph summary'] },
    ]);
  });

  it('treats absent sections as empty without throwing', () => {
    const persona = parsePersonaText('# Persona — Empty\n');
    expect(persona).toEqual({
      identity: {},
      voice: [],
      capabilities: [],
      accountabilities: [],
      success_criteria: [],
      inhibitions: [],
      initial_verbs: [],
    });
  });
});
