import { describe, expect, it } from 'vitest';

import {
  DocumentFieldsSchema,
  DraftFieldsSchema,
  OUTPUT_TYPES,
  OutputPathError,
  PlanFieldsSchema,
  RecordFieldsSchema,
  ReferenceFieldsSchema,
  STATUS_ENUM,
  StatusSchema,
  fieldsSchemaFor,
  resolveOutputPath,
} from './types.js';

describe('OUTPUT_TYPES registry', () => {
  it('declares the five framework primitives', () => {
    expect(Object.keys(OUTPUT_TYPES).sort()).toEqual(
      ['document', 'draft', 'plan', 'record', 'reference'].sort(),
    );
  });

  it('records expected required fields per type', () => {
    expect(OUTPUT_TYPES.document.required).toEqual(['title']);
    expect(OUTPUT_TYPES.draft.required).toEqual([]);
    expect(OUTPUT_TYPES.record.required).toEqual(['entity_type', 'entity_id', 'observed_at']);
    expect(OUTPUT_TYPES.plan.required).toEqual(['goal']);
    expect(OUTPUT_TYPES.reference.required).toEqual(['topic']);
  });

  it('exposes draft channel enum', () => {
    expect(OUTPUT_TYPES.draft.channelEnum).toEqual([
      'email',
      'slack',
      'dm',
      'letter',
      'call',
      'other',
    ]);
  });
});

describe('STATUS_ENUM', () => {
  it('contains the six lifecycle states in order', () => {
    expect(STATUS_ENUM).toEqual(['draft', 'review', 'ready', 'sent', 'done', 'archived']);
  });

  it('Zod schema rejects unknown statuses', () => {
    expect(StatusSchema.safeParse('draft').success).toBe(true);
    expect(StatusSchema.safeParse('sent').success).toBe(true);
    expect(StatusSchema.safeParse('rejected').success).toBe(false);
    expect(StatusSchema.safeParse('').success).toBe(false);
  });
});

describe('per-type field schemas', () => {
  it('document requires title', () => {
    expect(DocumentFieldsSchema.safeParse({}).success).toBe(false);
    expect(DocumentFieldsSchema.safeParse({ title: '' }).success).toBe(false);
    expect(DocumentFieldsSchema.safeParse({ title: 'Q1 brief' }).success).toBe(true);
    expect(
      DocumentFieldsSchema.safeParse({ title: 'Q1 brief', audience: 'exec' }).success,
    ).toBe(true);
  });

  it('draft accepts empty fields object', () => {
    expect(DraftFieldsSchema.safeParse({}).success).toBe(true);
    expect(
      DraftFieldsSchema.safeParse({ recipient: 'mary@acme.com', channel: 'email' }).success,
    ).toBe(true);
  });

  it('draft rejects invalid channel enum', () => {
    expect(DraftFieldsSchema.safeParse({ channel: 'fax' }).success).toBe(false);
    expect(DraftFieldsSchema.safeParse({ channel: 'email' }).success).toBe(true);
  });

  it('record requires entity_type, entity_id, observed_at (slug-shaped)', () => {
    expect(RecordFieldsSchema.safeParse({}).success).toBe(false);
    expect(
      RecordFieldsSchema.safeParse({
        entity_type: 'account',
        entity_id: 'acme',
        observed_at: '2026-05-13',
      }).success,
    ).toBe(true);
    // entity_type must match slug regex
    expect(
      RecordFieldsSchema.safeParse({
        entity_type: 'Account',
        entity_id: 'acme',
        observed_at: '2026-05-13',
      }).success,
    ).toBe(false);
  });

  it('plan requires goal', () => {
    expect(PlanFieldsSchema.safeParse({}).success).toBe(false);
    expect(PlanFieldsSchema.safeParse({ goal: 'Land Acme contract' }).success).toBe(true);
  });

  it('reference requires topic and accepts tags array', () => {
    expect(ReferenceFieldsSchema.safeParse({}).success).toBe(false);
    expect(ReferenceFieldsSchema.safeParse({ topic: 'pricing-objections' }).success).toBe(true);
    expect(
      ReferenceFieldsSchema.safeParse({ topic: 'pricing', tags: ['a', 'b'] }).success,
    ).toBe(true);
  });

  it('fieldsSchemaFor returns the right schema per type', () => {
    expect(fieldsSchemaFor('document')).toBe(DocumentFieldsSchema);
    expect(fieldsSchemaFor('draft')).toBe(DraftFieldsSchema);
    expect(fieldsSchemaFor('record')).toBe(RecordFieldsSchema);
    expect(fieldsSchemaFor('plan')).toBe(PlanFieldsSchema);
    expect(fieldsSchemaFor('reference')).toBe(ReferenceFieldsSchema);
  });
});

describe('resolveOutputPath', () => {
  it('builds single-segment paths for non-record types', () => {
    expect(resolveOutputPath({ type: 'document', slug: 'q1-brief' })).toBe(
      'output/document/q1-brief.md',
    );
    expect(resolveOutputPath({ type: 'draft', slug: 'cold-email-mary' })).toBe(
      'output/draft/cold-email-mary.md',
    );
    expect(resolveOutputPath({ type: 'plan', slug: 'land-acme' })).toBe(
      'output/plan/land-acme.md',
    );
    expect(resolveOutputPath({ type: 'reference', slug: 'pricing-objections' })).toBe(
      'output/reference/pricing-objections.md',
    );
  });

  it('builds entity-scoped paths for records', () => {
    expect(
      resolveOutputPath({
        type: 'record',
        slug: '2026-q1-read',
        entity_type: 'account',
        entity_id: 'acme',
      }),
    ).toBe('output/record/account/acme/2026-q1-read.md');
  });

  it('rejects record paths missing entity_type/entity_id', () => {
    expect(() =>
      resolveOutputPath({ type: 'record', slug: 'x' }),
    ).toThrow(OutputPathError);
  });

  it('rejects malformed slugs', () => {
    expect(() =>
      resolveOutputPath({ type: 'document', slug: 'Q1-Brief' }),
    ).toThrow(OutputPathError);
    expect(() =>
      resolveOutputPath({ type: 'document', slug: '../escape' }),
    ).toThrow(OutputPathError);
  });

  it('rejects malformed entity segments', () => {
    expect(() =>
      resolveOutputPath({
        type: 'record',
        slug: 'note',
        entity_type: 'Account',
        entity_id: 'acme',
      }),
    ).toThrow(OutputPathError);
  });
});
