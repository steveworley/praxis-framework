import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personaNameFrom, resolvePersonaName } from './persona-name.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-persona-name-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writePersona(identityBlock: string): Promise<void> {
  const text = `# Persona — Example\n\n## Identity\n\n${identityBlock}\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I do the thing\n\n## Hard inhibitions\n\n- I never miss\n`;
  await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
}

describe('resolvePersonaName', () => {
  it('prefers full_name when authored', async () => {
    await writePersona(
      '- **Full name**: Monika Cosic\n- **Working title**: Sales lead\n- **Role name**: sales-lead',
    );
    const name = await resolvePersonaName(tempDir);
    expect(name).toEqual({
      full: 'Monika Cosic',
      short: 'Monika',
      title: 'Sales lead',
      identifier: 'sales-lead',
    });
  });

  it('falls back to working_title when full_name is absent', async () => {
    await writePersona(
      '- **Working title**: Sales lead\n- **Role name**: sales-lead',
    );
    const name = await resolvePersonaName(tempDir);
    expect(name).toEqual({
      full: 'Sales lead',
      short: 'Sales',
      title: 'Sales lead',
      identifier: 'sales-lead',
    });
  });

  it('falls back to title-cased role_name slug when neither full nor title is set', async () => {
    await writePersona('- **Role name**: sales-lead');
    const name = await resolvePersonaName(tempDir);
    expect(name).toEqual({
      full: 'Sales Lead',
      short: 'Sales',
      identifier: 'sales-lead',
    });
  });

  it('falls back to "the role" when persona.md is missing entirely', async () => {
    const name = await resolvePersonaName(tempDir);
    expect(name).toEqual({
      full: 'the role',
      short: 'the',
      identifier: '',
    });
  });

  it('uses full as short when there is no space (single-name personas)', async () => {
    await writePersona('- **Full name**: Iris\n- **Role name**: iris');
    const name = await resolvePersonaName(tempDir);
    expect(name.full).toBe('Iris');
    expect(name.short).toBe('Iris');
  });

  it('skips full_name when it is just the slug (treats as unset)', async () => {
    // If the operator authored "Full name: sales-lead" we treat that as
    // unset — the slug is not a real name.
    await writePersona(
      '- **Full name**: sales-lead\n- **Working title**: Sales lead\n- **Role name**: sales-lead',
    );
    const name = await resolvePersonaName(tempDir);
    expect(name.full).toBe('Sales lead');
    expect(name.short).toBe('Sales');
  });
});

describe('personaNameFrom', () => {
  it('returns the "the role" fallback for a null persona', () => {
    expect(personaNameFrom(null)).toEqual({
      full: 'the role',
      short: 'the',
      identifier: '',
    });
  });

  it('accepts a `name` identity field as a synonym for full_name', () => {
    const name = personaNameFrom({
      identity: { name: 'Iris Chen', role_name: 'csm-agent' },
      voice: [],
      capabilities: [],
      accountabilities: [],
      success_criteria: [],
      inhibitions: [],
      initial_verbs: [],
    });
    expect(name.full).toBe('Iris Chen');
    expect(name.short).toBe('Iris');
    expect(name.identifier).toBe('csm-agent');
  });
});
