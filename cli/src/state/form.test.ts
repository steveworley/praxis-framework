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
});
