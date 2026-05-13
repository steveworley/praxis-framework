import { describe, expect, it } from 'vitest';

import {
  applyAction,
  initialState,
  trimEmptyRows,
  type ListBuilderConfig,
} from './list-builder-state.js';

interface TwoFieldRow {
  trait: string;
  qualifier: string;
}

const twoFieldConfig: ListBuilderConfig<TwoFieldRow> = {
  fields: [
    {
      extract: (r) => r.trait,
      apply: (r, v) => ({ ...r, trait: v }),
    },
    {
      extract: (r) => r.qualifier,
      apply: (r, v) => ({ ...r, qualifier: v }),
    },
  ],
  empty: () => ({ trait: '', qualifier: '' }),
  max: 8,
};

const expectState = <T,>(
  result: ReturnType<typeof applyAction<T>>,
): { items: T[]; rowIdx: number; fieldIdx: number; draft: string } => {
  if (result.kind !== 'state') {
    throw new Error(`expected state transition, got ${result.kind}`);
  }
  return result.state;
};

describe('initialState', () => {
  it('seeds an empty editable row when initial is empty', () => {
    const s = initialState<TwoFieldRow>([], twoFieldConfig);
    expect(s.items).toEqual([{ trait: '', qualifier: '' }]);
    expect(s.rowIdx).toBe(0);
    expect(s.fieldIdx).toBe(0);
    expect(s.draft).toBe('');
  });

  it('reuses initial items and reads draft from the first cell', () => {
    const s = initialState<TwoFieldRow>(
      [{ trait: 'direct', qualifier: 'no hedging' }],
      twoFieldConfig,
    );
    expect(s.items).toHaveLength(1);
    expect(s.draft).toBe('direct');
  });
});

describe('applyAction → tab', () => {
  it('commits the in-flight draft into the focused field before moving', () => {
    // Reproduces the reported bug: typed "direct" into trait, hit tab, started
    // typing into qualifier. With the old useInput-based flow the leading "d"
    // raced with a row-clear shortcut; here we exercise the same transition
    // sequence purely.
    let s = initialState<TwoFieldRow>([], twoFieldConfig);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'direct' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'tab' }, twoFieldConfig));

    expect(s.items[0]).toEqual({ trait: 'direct', qualifier: '' });
    expect(s.fieldIdx).toBe(1);
    expect(s.draft).toBe('');

    s = expectState(applyAction(s, { type: 'setDraft', value: 'is clear and concise' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'tab' }, twoFieldConfig));

    expect(s.items[0]).toEqual({ trait: 'direct', qualifier: 'is clear and concise' });
    // Tab past the last field cycles back to field 0 within the same row,
    // and the draft mirrors whatever is now stored there.
    expect(s.fieldIdx).toBe(0);
    expect(s.draft).toBe('direct');
  });

  it('cycles within the row when tab passes the last field', () => {
    let s = initialState<TwoFieldRow>(
      [{ trait: 'direct', qualifier: 'no hedging' }],
      twoFieldConfig,
    );
    s = expectState(applyAction(s, { type: 'tab' }, twoFieldConfig));
    expect(s.fieldIdx).toBe(1);
    s = expectState(applyAction(s, { type: 'tab' }, twoFieldConfig));
    expect(s.fieldIdx).toBe(0);
  });
});

describe('applyAction → down', () => {
  it('grows the list when the operator advances past the last row', () => {
    let s = initialState<TwoFieldRow>([], twoFieldConfig);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'direct' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'down' }, twoFieldConfig));
    expect(s.items).toHaveLength(2);
    expect(s.items[0]?.trait).toBe('direct');
    expect(s.rowIdx).toBe(1);
    expect(s.draft).toBe('');
  });

  it('refuses to grow past the configured max', () => {
    const cap2: ListBuilderConfig<TwoFieldRow> = { ...twoFieldConfig, max: 2 };
    let s = initialState<TwoFieldRow>([], cap2);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'a' }, cap2));
    s = expectState(applyAction(s, { type: 'down' }, cap2));
    s = expectState(applyAction(s, { type: 'setDraft', value: 'b' }, cap2));
    s = expectState(applyAction(s, { type: 'down' }, cap2));
    expect(s.items).toHaveLength(2);
    expect(s.rowIdx).toBe(1);
  });
});

describe('applyAction → up', () => {
  it('moves to the previous row, committing first', () => {
    let s = initialState<TwoFieldRow>([], twoFieldConfig);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'direct' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'down' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'setDraft', value: 'curious' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'up' }, twoFieldConfig));
    expect(s.rowIdx).toBe(0);
    expect(s.items[1]?.trait).toBe('curious');
    expect(s.draft).toBe('direct');
  });

  it('is a no-op at the top row', () => {
    const s0 = initialState<TwoFieldRow>([], twoFieldConfig);
    const s1 = expectState(applyAction(s0, { type: 'up' }, twoFieldConfig));
    expect(s1).toEqual(s0);
  });
});

describe('applyAction → deleteRow', () => {
  it('clears (rather than empties) the list when only one row remains', () => {
    let s = initialState<TwoFieldRow>(
      [{ trait: 'direct', qualifier: 'no hedging' }],
      twoFieldConfig,
    );
    s = expectState(applyAction(s, { type: 'deleteRow' }, twoFieldConfig));
    expect(s.items).toEqual([{ trait: '', qualifier: '' }]);
    expect(s.rowIdx).toBe(0);
  });

  it('removes the focused row and clamps rowIdx within bounds', () => {
    const initial: TwoFieldRow[] = [
      { trait: 'a', qualifier: '' },
      { trait: 'b', qualifier: '' },
      { trait: 'c', qualifier: '' },
    ];
    let s = initialState<TwoFieldRow>(initial, twoFieldConfig);
    s = expectState(applyAction(s, { type: 'down' }, twoFieldConfig));
    expect(s.rowIdx).toBe(1);
    s = expectState(applyAction(s, { type: 'deleteRow' }, twoFieldConfig));
    expect(s.items.map((r) => r.trait)).toEqual(['a', 'c']);
    expect(s.rowIdx).toBe(1);
  });
});

describe('applyAction → submit', () => {
  it('advances to the next row when the operator submits a non-final row', () => {
    // Same shape as down: commit, move forward. Tests the path through the
    // existing-row branch rather than the append branch.
    let s = initialState<TwoFieldRow>(
      [
        { trait: 'a', qualifier: '' },
        { trait: 'b', qualifier: '' },
      ],
      twoFieldConfig,
    );
    s = expectState(applyAction(s, { type: 'setDraft', value: 'aa' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'submit' }, twoFieldConfig));
    expect(s.rowIdx).toBe(1);
    expect(s.items[0]?.trait).toBe('aa');
    expect(s.draft).toBe('b');
  });

  it('appends a new empty row and focuses it when enter fires on a populated last row', () => {
    // The headline behaviour of the new submit semantics: shift+enter would
    // pollute the buffer with `\n`, so bare enter takes over the
    // "submit and add another" affordance.
    let s = initialState<TwoFieldRow>([], twoFieldConfig);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'direct' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'tab' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'setDraft', value: 'no hedging' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'submit' }, twoFieldConfig));

    expect(s.items).toEqual([
      { trait: 'direct', qualifier: 'no hedging' },
      { trait: '', qualifier: '' },
    ]);
    expect(s.rowIdx).toBe(1);
    // New row always lands focus back on the first field — the operator's
    // muscle memory for "type, tab, type, enter" wants to start fresh.
    expect(s.fieldIdx).toBe(0);
    expect(s.draft).toBe('');
  });

  it('finalises and trims when enter fires on an empty trailing row', () => {
    let s = initialState<TwoFieldRow>([], twoFieldConfig);
    s = expectState(applyAction(s, { type: 'setDraft', value: 'direct' }, twoFieldConfig));
    s = expectState(applyAction(s, { type: 'down' }, twoFieldConfig));
    // Sit on an empty trailing row — submit should drop it and finalise.
    const result = applyAction(s, { type: 'submit' }, twoFieldConfig);
    if (result.kind !== 'finalise') {
      throw new Error('expected finalise');
    }
    expect(result.items).toEqual([{ trait: 'direct', qualifier: '' }]);
  });

  it('finalises when enter fires on a non-last row at max capacity', () => {
    // Subtle: at max, enter on a populated last row finalises — the
    // operator can't append more rows and shouldn't be silently stuck.
    const cap2: ListBuilderConfig<TwoFieldRow> = { ...twoFieldConfig, max: 2 };
    let s = initialState<TwoFieldRow>(
      [
        { trait: 'a', qualifier: '' },
        { trait: 'b', qualifier: '' },
      ],
      cap2,
    );
    s = expectState(applyAction(s, { type: 'down' }, cap2));
    expect(s.rowIdx).toBe(1);
    const result = applyAction(s, { type: 'submit' }, cap2);
    if (result.kind !== 'finalise') {
      throw new Error('expected finalise');
    }
    expect(result.items).toEqual([
      { trait: 'a', qualifier: '' },
      { trait: 'b', qualifier: '' },
    ]);
  });

  it('does not advance when the focused row fails the configured validator', () => {
    // Mirrors the protective behaviour of the finalise path: the operator
    // can't tab past a row that won't ultimately pass validation, and the
    // row's inline error (rendered by the component using the same
    // validator) becomes visible because focus has stayed put.
    const validatedConfig: ListBuilderConfig<TwoFieldRow> = {
      ...twoFieldConfig,
      validate: (r) =>
        r.trait.trim().length === 0 ? 'trait is required' : null,
    };
    let s = initialState<TwoFieldRow>([], validatedConfig);
    // Type into qualifier without filling trait, then enter — row has
    // content (so it isn't "empty" → wouldn't finalise) but is invalid.
    s = expectState(applyAction(s, { type: 'tab' }, validatedConfig));
    s = expectState(
      applyAction(s, { type: 'setDraft', value: 'no hedging' }, validatedConfig),
    );
    const result = applyAction(s, { type: 'submit' }, validatedConfig);
    if (result.kind !== 'state') {
      throw new Error('expected state, got finalise');
    }
    expect(result.state.items).toEqual([{ trait: '', qualifier: 'no hedging' }]);
    expect(result.state.rowIdx).toBe(0);
    // Stays on the same field the operator was editing — they likely
    // tabbed past trait by mistake; jumping back to field 0 would be
    // surprising. The inline error surfaces underneath the row instead.
    expect(result.state.fieldIdx).toBe(1);
  });

  it('advances on enter when the validator passes, even on multi-field rows', () => {
    const validatedConfig: ListBuilderConfig<TwoFieldRow> = {
      ...twoFieldConfig,
      validate: (r) =>
        r.trait.trim().length === 0 ? 'trait is required' : null,
    };
    let s = initialState<TwoFieldRow>([], validatedConfig);
    s = expectState(
      applyAction(s, { type: 'setDraft', value: 'direct' }, validatedConfig),
    );
    // Submit from field 0 with field 1 still empty — validator only
    // requires `trait`, so this should append a new row.
    s = expectState(applyAction(s, { type: 'submit' }, validatedConfig));
    expect(s.items).toEqual([
      { trait: 'direct', qualifier: '' },
      { trait: '', qualifier: '' },
    ]);
    expect(s.rowIdx).toBe(1);
    expect(s.fieldIdx).toBe(0);
  });
});

describe('trimEmptyRows', () => {
  it('drops rows that have nothing in any field', () => {
    const items: TwoFieldRow[] = [
      { trait: 'a', qualifier: '' },
      { trait: '', qualifier: '' },
      { trait: '', qualifier: 'orphaned qualifier still counts as content' },
    ];
    expect(trimEmptyRows(items, twoFieldConfig)).toEqual([
      { trait: 'a', qualifier: '' },
      { trait: '', qualifier: 'orphaned qualifier still counts as content' },
    ]);
  });
});
