import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePersona } from './persona-parser.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-persona-'));
  await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('parsePersona', () => {
  it('returns empty structures when persona.md is missing', async () => {
    const persona = await parsePersona(tempDir);
    expect(persona).toEqual({ identity: {}, voice: [], capabilities: [], inhibitions: [] });
  });

  it('parses identity, voice, capabilities, and inhibitions', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n- **Role**: CSM agent\n- **Email**: iris@example.com\n\n## Voice & Personality\n\n- **Direct** -- prefers single-sentence opens\n- **Warm** -- never uses corporate filler\n\n## Capabilities\n\nWhat I can do.\n\n- I can read accounts weekly\n- I can summarise threads\n\n## Hard inhibitions\n\n- I never send emails without approval\n`;
    await fs.writeFile(path.join(tempDir, 'agents', 'persona.md'), text, 'utf-8');
    const persona = await parsePersona(tempDir);
    expect(persona.identity).toEqual({
      full_name: 'Iris Chen',
      role: 'CSM agent',
      email: 'iris@example.com',
    });
    expect(persona.voice).toEqual([
      { label: 'Direct', detail: 'prefers single-sentence opens' },
      { label: 'Warm', detail: 'never uses corporate filler' },
    ]);
    expect(persona.capabilities).toEqual(['I can read accounts weekly', 'I can summarise threads']);
    expect(persona.inhibitions).toEqual(['I never send emails without approval']);
  });
});
