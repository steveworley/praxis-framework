import { describe, expect, it } from 'vitest';
import { Form, Organisation, RoleDefinition, emptyForm } from './form.js';

describe('Organisation schema', () => {
  it('accepts a minimal valid record', () => {
    const result = Organisation.safeParse({ name: 'Acme' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = Organisation.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts every documented size value', () => {
    const sizes = ['solo', 'small', 'mid', 'large', 'enterprise'] as const;
    for (const size of sizes) {
      const result = Organisation.safeParse({ name: 'Acme', size });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown size value', () => {
    const result = Organisation.safeParse({ name: 'Acme', size: 'huge' });
    expect(result.success).toBe(false);
  });

  it('treats optional fields as truly optional', () => {
    const result = Organisation.safeParse({ name: 'Acme' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.website).toBeUndefined();
      expect(result.data.sector).toBeUndefined();
    }
  });
});

describe('RoleDefinition schema', () => {
  it('requires role_name and one_sentence_purpose', () => {
    const ok = RoleDefinition.safeParse({
      role_name: 'bd',
      one_sentence_purpose: 'sell stuff',
    });
    expect(ok.success).toBe(true);

    const missingPurpose = RoleDefinition.safeParse({ role_name: 'bd' });
    expect(missingPurpose.success).toBe(false);

    const missingName = RoleDefinition.safeParse({
      one_sentence_purpose: 'sell stuff',
    });
    expect(missingName.success).toBe(false);
  });

  it('rejects empty required strings', () => {
    const result = RoleDefinition.safeParse({
      role_name: '',
      one_sentence_purpose: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('Form schema', () => {
  it('accepts the empty-form default', () => {
    const result = Form.safeParse(emptyForm());
    expect(result.success).toBe(true);
  });

  it('defaults path to "unset" when omitted', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('unset');
    }
  });

  it('accepts the three documented path values', () => {
    for (const path of ['research', 'manual', 'unset'] as const) {
      const result = Form.safeParse({
        organisation: {},
        role_definition: {},
        path,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown path value', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
      path: 'mystery',
    });
    expect(result.success).toBe(false);
  });

  it('accepts partial organisation and role_definition objects', () => {
    const result = Form.safeParse({
      organisation: { name: 'Acme', sector: 'SaaS' },
      role_definition: { role_name: 'bd' },
      path: 'manual',
    });
    expect(result.success).toBe(true);
  });

  it('defaults tools to an empty array when omitted', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual([]);
    }
  });

  it('accepts a populated tools array of capability names', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
      tools: ['mcp:slack', 'mcp:google-workspace'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual(['mcp:slack', 'mcp:google-workspace']);
    }
  });

  it('rejects a tools entry that is not a string', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
      tools: [123],
    });
    expect(result.success).toBe(false);
  });

  it('emptyForm() includes an empty tools array', () => {
    expect(emptyForm().tools).toEqual([]);
  });

  it('defaults voice_traits, capabilities, inhibitions, initial_verbs to empty arrays', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voice_traits).toEqual([]);
      expect(result.data.capabilities).toEqual([]);
      expect(result.data.inhibitions).toEqual([]);
      expect(result.data.initial_verbs).toEqual([]);
    }
  });

  it('round-trips a populated form including the new manual-path fields', () => {
    const populated = {
      organisation: { name: 'Acme' },
      role_definition: { role_name: 'bd', one_sentence_purpose: 'sell' },
      path: 'manual' as const,
      tools: ['mcp:slack'],
      voice_traits: [
        { trait: 'direct', qualifiers: ['names the next step in every reply'] },
      ],
      capabilities: ['drafts cold-outreach emails'],
      inhibitions: ['never quote prices without sign-off'],
      initial_verbs: [
        {
          slug: 'account-curator',
          description: ['maintain account state', 'flag stale records'],
        },
      ],
    };
    const result = Form.safeParse(populated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voice_traits).toEqual(populated.voice_traits);
      expect(result.data.capabilities).toEqual(populated.capabilities);
      expect(result.data.inhibitions).toEqual(populated.inhibitions);
      expect(result.data.initial_verbs).toEqual(populated.initial_verbs);
    }
  });

  it('accepts an initial_verbs entry with no description bullets', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
      initial_verbs: [{ slug: 'bd' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.initial_verbs[0]?.description).toEqual([]);
    }
  });

  it('accepts a voice_traits entry with no qualifiers', () => {
    const result = Form.safeParse({
      organisation: {},
      role_definition: {},
      voice_traits: [{ trait: 'direct' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voice_traits[0]?.qualifiers).toEqual([]);
    }
  });

  it('rejects voice_traits entries missing the canonical trait name', () => {
    const missingTrait = Form.safeParse({
      organisation: {},
      role_definition: {},
      voice_traits: [{ trait: '', qualifiers: ['anything'] }],
    });
    expect(missingTrait.success).toBe(false);
  });

  it('rejects initial_verbs entries with an empty slug', () => {
    const missingSlug = Form.safeParse({
      organisation: {},
      role_definition: {},
      initial_verbs: [{ slug: '', description: [] }],
    });
    expect(missingSlug.success).toBe(false);
  });

  it('rejects initial_verbs description entries that are not strings', () => {
    const bad = Form.safeParse({
      organisation: {},
      role_definition: {},
      initial_verbs: [{ slug: 'bd', description: [123] }],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects non-string entries in capabilities/inhibitions arrays', () => {
    const bad = Form.safeParse({
      organisation: {},
      role_definition: {},
      capabilities: [123],
    });
    expect(bad.success).toBe(false);
  });

  it('emptyForm() includes empty arrays for all manual-path fields', () => {
    const f = emptyForm();
    expect(f.voice_traits).toEqual([]);
    expect(f.capabilities).toEqual([]);
    expect(f.inhibitions).toEqual([]);
    expect(f.initial_verbs).toEqual([]);
  });
});
