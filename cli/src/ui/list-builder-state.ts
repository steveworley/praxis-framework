/**
 * Pure state machine for {@link ListBuilder}. Extracted so the navigation /
 * commit / focus rules can be unit-tested without rendering Ink, and so the
 * component itself stays a thin presentational shell over `applyAction()`.
 *
 * The component owns three pieces of state that move together — `items`,
 * `(rowIdx, fieldIdx)`, and the in-flight `draft` buffer — and a bug fixed
 * here lived in the gap between them. The original useInput handler bound
 * plain alphabetic keys (`j`, `k`, `d`) as navigation/delete shortcuts; those
 * shortcuts also fired while a `TextInput` was focused, so a user typing
 * `direct` would have the leading `d` racing with a row-clear. Centralising
 * the rules into one transition function makes it obvious which keys mutate
 * structure (tab/arrow/return/escape/empty-backspace) and which are purely
 * for the text input to consume.
 */

export interface FieldExtractor<T> {
  extract: (item: T) => string;
  apply: (item: T, value: string) => T;
}

export interface ListBuilderState<T> {
  items: T[];
  rowIdx: number;
  fieldIdx: number;
  draft: string;
}

export interface ListBuilderConfig<T> {
  fields: FieldExtractor<T>[];
  empty: () => T;
  /** Inclusive maximum item count — adding more rows is blocked at the cap. */
  max: number;
  /**
   * Optional per-row validator. When provided, the state machine consults it
   * before promoting / appending in response to `submit`: an invalid row
   * blocks advance so focus stays on the failing row and the inline error
   * (rendered by the component from the same validator) becomes visible.
   *
   * The component-level finalise path also runs `validate`, so this is the
   * "advance gate" twin of the same rule — the two share semantics so the
   * operator can never tab past a row that won't ultimately pass finalise.
   */
  validate?: (item: T) => string | null;
}

export type ListBuilderAction =
  | { type: 'tab' }
  | { type: 'down' }
  | { type: 'up' }
  | { type: 'deleteRow' }
  | { type: 'submit' }
  | { type: 'setDraft'; value: string };

export type ListBuilderTransition<T> =
  | { kind: 'state'; state: ListBuilderState<T> }
  | { kind: 'finalise'; items: T[] };

/**
 * Build the initial state for a fresh ListBuilder mount. Always seeds at
 * least one editable row so the operator has somewhere to start; the empty
 * trailing row is dropped at finalise time.
 */
export function initialState<T>(
  initial: T[],
  config: ListBuilderConfig<T>,
): ListBuilderState<T> {
  const items = initial.length > 0 ? [...initial] : [config.empty()];
  const draft = readDraft(items, 0, 0, config);
  return { items, rowIdx: 0, fieldIdx: 0, draft };
}

/**
 * Apply a user-driven action to the state. Returns either the next state
 * (`kind: 'state'`) or a finalise signal (`kind: 'finalise'`) carrying the
 * trimmed items the caller should hand to `onNext`.
 *
 * The pure-function shape means tests can drive the same transitions the
 * component does without setting up Ink, React, or input plumbing.
 */
export function applyAction<T>(
  state: ListBuilderState<T>,
  action: ListBuilderAction,
  config: ListBuilderConfig<T>,
): ListBuilderTransition<T> {
  switch (action.type) {
    case 'setDraft':
      return { kind: 'state', state: { ...state, draft: action.value } };

    case 'tab': {
      if (config.fields.length === 0) {
        return { kind: 'state', state };
      }
      const committed = commit(state, config);
      const nextField = (state.fieldIdx + 1) % config.fields.length;
      return {
        kind: 'state',
        state: refocus(committed, state.rowIdx, nextField, config),
      };
    }

    case 'down': {
      const committed = commit(state, config);
      if (committed.rowIdx < committed.items.length - 1) {
        return {
          kind: 'state',
          state: refocus(committed, committed.rowIdx + 1, 0, config),
        };
      }
      if (committed.items.length < config.max) {
        const grown: ListBuilderState<T> = {
          ...committed,
          items: [...committed.items, config.empty()],
        };
        return {
          kind: 'state',
          state: refocus(grown, grown.items.length - 1, 0, config),
        };
      }
      return { kind: 'state', state: committed };
    }

    case 'up': {
      if (state.rowIdx === 0) {
        return { kind: 'state', state };
      }
      const committed = commit(state, config);
      return {
        kind: 'state',
        state: refocus(committed, committed.rowIdx - 1, 0, config),
      };
    }

    case 'deleteRow': {
      // If only one row remains, "delete" clears it back to empty rather
      // than leaving the operator with zero rows to type into.
      if (state.items.length <= 1) {
        const cleared = [config.empty()];
        return {
          kind: 'state',
          state: refocus({ ...state, items: cleared }, 0, 0, config),
        };
      }
      const next = state.items.filter((_, i) => i !== state.rowIdx);
      const nextRow = Math.min(state.rowIdx, next.length - 1);
      return {
        kind: 'state',
        state: refocus({ ...state, items: next }, nextRow, 0, config),
      };
    }

    case 'submit': {
      // Enter is "submit and add another" — commit the in-flight draft, then
      // either advance to the next row (existing or freshly appended) or
      // finalise. Finalise only fires when the operator hits enter on a row
      // that is genuinely empty, mirroring "you've stopped adding things".
      const committed = commit(state, config);
      const focusedRow = committed.items[committed.rowIdx];
      const focusedRowEmpty =
        focusedRow !== undefined &&
        config.fields.every((f) => f.extract(focusedRow).trim().length === 0);
      const isLast = committed.rowIdx === committed.items.length - 1;

      // Empty trailing row — operator is signalling "I'm done". Drop the
      // empty row and let the parent run its min/validate gates.
      if (isLast && focusedRowEmpty) {
        return {
          kind: 'finalise',
          items: trimEmptyRows(committed.items, config),
        };
      }

      // Row has content — gate advancement on the row-level validator so the
      // operator can't accumulate broken rows and only discover it on
      // finalise. Without an advance, focus stays put and the row's inline
      // error (rendered by the component using the same validator) surfaces.
      if (focusedRow !== undefined && config.validate) {
        const err = config.validate(focusedRow);
        if (err !== null) {
          return { kind: 'state', state: committed };
        }
      }

      if (!isLast) {
        // Same as ↓: commit current, move to existing next row.
        return {
          kind: 'state',
          state: refocus(committed, committed.rowIdx + 1, 0, config),
        };
      }

      // Last row, valid, has content. Try to grow; if at max, finalise so
      // the operator isn't stuck pressing keys with no visible effect.
      if (committed.items.length < config.max) {
        const grown: ListBuilderState<T> = {
          ...committed,
          items: [...committed.items, config.empty()],
        };
        return {
          kind: 'state',
          state: refocus(grown, grown.items.length - 1, 0, config),
        };
      }
      return { kind: 'finalise', items: trimEmptyRows(committed.items, config) };
    }

    default:
      return { kind: 'state', state };
  }
}

/**
 * Strip rows where every field is blank — these are the "press enter to
 * add another" affordance, not real entries.
 */
export function trimEmptyRows<T>(items: T[], config: ListBuilderConfig<T>): T[] {
  return items.filter((item) =>
    config.fields.some((f) => f.extract(item).trim().length > 0),
  );
}

function readDraft<T>(
  items: T[],
  rowIdx: number,
  fieldIdx: number,
  config: ListBuilderConfig<T>,
): string {
  const item = items[rowIdx];
  const field = config.fields[fieldIdx];
  return item && field ? field.extract(item) : '';
}

function commit<T>(
  state: ListBuilderState<T>,
  config: ListBuilderConfig<T>,
): ListBuilderState<T> {
  const item = state.items[state.rowIdx];
  const field = config.fields[state.fieldIdx];
  if (!item || !field) return state;
  const nextItem = field.apply(item, state.draft.trim());
  const nextItems = [...state.items];
  nextItems[state.rowIdx] = nextItem;
  return { ...state, items: nextItems };
}

function refocus<T>(
  state: ListBuilderState<T>,
  rowIdx: number,
  fieldIdx: number,
  config: ListBuilderConfig<T>,
): ListBuilderState<T> {
  return {
    ...state,
    rowIdx,
    fieldIdx,
    draft: readDraft(state.items, rowIdx, fieldIdx, config),
  };
}
