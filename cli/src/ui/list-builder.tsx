import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { accent, muted, ok, warn } from './theme.js';
import {
  applyAction,
  initialState,
  trimEmptyRows,
  type ListBuilderConfig,
  type ListBuilderState,
} from './list-builder-state.js';

/**
 * Description of one editable text field within a row.
 *
 * `label` appears as a column header and inline prompt; `placeholder` is
 * shown inside the input when empty (e.g. `(required)`); `extract` and
 * `apply` let the list-builder stay generic over `T` while still letting
 * the caller decide how a row maps to its underlying string fields.
 */
export interface FieldSpec<T> {
  key: string;
  label: string;
  placeholder?: string;
  extract: (item: T) => string;
  apply: (item: T, value: string) => T;
}

export interface ListBuilderProps<T> {
  title: string;
  helper: string;
  /** Existing items to seed the list — usually `form.<field>` from the parent. */
  initial: T[];
  fields: FieldSpec<T>[];
  /** Builds a fresh, empty item — used when adding a row. */
  empty: () => T;
  /**
   * Per-row validator. Return null when the row is valid, or an error
   * message when it isn't. Errors block enter-to-finalise.
   */
  validate: (item: T) => string | null;
  /** Inclusive minimum item count required to finalise. */
  min: number;
  /** Inclusive maximum item count — adding more rows is blocked at the cap. */
  max: number;
  onNext: (items: T[]) => void;
  onCancel: () => void;
}

/**
 * Generic add/edit/delete list builder. Keeps the row data structure
 * opaque to the component — callers describe the editable fields via
 * `fields` and how to mint a new item via `empty`.
 *
 * Interactions:
 *   ↑/↓         navigate rows (↓ on the last row appends an empty trailing row)
 *   tab         cycle editable field within the focused row
 *   enter       "next entry" — commit the current row and either advance to the
 *               next existing row, append a new empty row at the bottom, or
 *               finalise (the latter when the focused row is itself empty, or
 *               when the row count is already at `max`).
 *   backspace   on an empty row → delete it
 *   esc         cancel the entire step
 *
 * Why enter doesn't always finalise: shift+enter is the operator's natural
 * "submit and add another" shortcut, but Ink's `useInput` broadcasts shift+enter
 * as a literal `\n` to the focused TextInput, polluting the data with embedded
 * newlines. So the framework remaps the bare-enter semantics to match the
 * intuition — finalise then becomes "press enter on an empty trailing row",
 * which is what falls out naturally after the operator's last item.
 *
 * Plain alphabetic keys (including `j`/`k`/`d`) are intentionally NOT bound
 * to navigation — they collide with text input. The reported "typed second
 * field's text into first field" bug came from `d` racing with the row-clear
 * shortcut while a `TextInput` was focused. The state machine that drives
 * this component lives in `./list-builder-state.ts` for unit-testing.
 */
export const ListBuilder = <T,>({
  title,
  helper,
  initial,
  fields,
  empty,
  validate,
  min,
  max,
  onNext,
  onCancel,
}: ListBuilderProps<T>) => {
  // Strip the FieldSpec down to what the state machine needs — the rest of
  // the spec (label, placeholder) is presentational only. `validate` is
  // forwarded so the state machine can refuse to advance past an invalid
  // row, matching the protective gate the finalise path already enforces.
  const config: ListBuilderConfig<T> = {
    fields: fields.map((f) => ({ extract: f.extract, apply: f.apply })),
    empty,
    max,
    validate,
  };
  const [state, setState] = useState<ListBuilderState<T>>(() =>
    initialState(initial, config),
  );
  const [topLevelError, setTopLevelError] = useState<string | null>(null);

  const finalise = (items: T[]) => {
    const trimmed = trimEmptyRows(items, config);
    if (trimmed.length < min) {
      setTopLevelError(
        min === 1
          ? 'At least one entry is required.'
          : `At least ${min} entries are required.`,
      );
      return;
    }
    for (const item of trimmed) {
      const err = validate(item);
      if (err !== null) {
        setTopLevelError(`Fix the highlighted row before continuing: ${err}`);
        return;
      }
    }
    onNext(trimmed);
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.tab) {
      setTopLevelError(null);
      const result = applyAction(state, { type: 'tab' }, config);
      if (result.kind === 'state') setState(result.state);
      return;
    }

    if (key.downArrow) {
      setTopLevelError(null);
      const result = applyAction(state, { type: 'down' }, config);
      if (result.kind === 'state') setState(result.state);
      return;
    }

    if (key.upArrow) {
      setTopLevelError(null);
      const result = applyAction(state, { type: 'up' }, config);
      if (result.kind === 'state') setState(result.state);
      return;
    }

    // Backspace on an empty draft (and only when more than one row exists)
    // deletes the focused row. The `TextInput` itself ignores backspace once
    // its cursor is at offset 0, so this doesn't fight the editor.
    if (
      key.backspace &&
      state.draft.length === 0 &&
      state.items.length > 1
    ) {
      const result = applyAction(state, { type: 'deleteRow' }, config);
      if (result.kind === 'state') setState(result.state);
      return;
    }

    // Plain printable characters fall through to the focused TextInput's own
    // `useInput` handler — we deliberately don't intercept them here so words
    // containing 'j', 'k', or 'd' type cleanly. (See header comment.)
    void input;
  });

  // ink-text-input swallows enter for us, so the submit handler is the
  // single place we decide whether enter advances to the next row, adds
  // a new trailing row, or finalises the step.
  const handleSubmit = () => {
    setTopLevelError(null);
    const result = applyAction(state, { type: 'submit' }, config);
    if (result.kind === 'finalise') {
      finalise(result.items);
      return;
    }
    setState(result.state);
  };

  const setDraft = (value: string) => {
    setTopLevelError(null);
    const result = applyAction(state, { type: 'setDraft', value }, config);
    if (result.kind === 'state') setState(result.state);
  };

  const focusedField = fields[state.fieldIdx];
  const focusedFieldKey = focusedField?.key ?? '';

  return (
    <Box flexDirection="column">
      {title.length > 0 ? (
        <Box marginBottom={1}>
          <Text>{accent(title)}</Text>
        </Box>
      ) : null}
      {helper.length > 0 ? (
        <Box marginBottom={1}>
          <Text>{muted(helper)}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {state.items.map((item, i) => {
          const isFocused = i === state.rowIdx;
          const rowErr = validate(item);
          const isRowEmpty = fields.every(
            (f) => f.extract(item).trim().length === 0,
          );
          return (
            <Row
              key={i}
              item={item}
              fields={fields}
              focused={isFocused}
              focusedFieldKey={isFocused ? focusedFieldKey : ''}
              draft={isFocused ? state.draft : null}
              setDraft={setDraft}
              onSubmit={handleSubmit}
              error={isRowEmpty ? null : rowErr}
            />
          );
        })}
        {state.items.length < max ? (
          <Box marginTop={0}>
            <Text>
              {muted('  ↳ ')}
              {muted(
                state.items.length === 0
                  ? 'press enter to add the first entry'
                  : 'enter to add another (or finish on an empty row)',
              )}
            </Text>
          </Box>
        ) : (
          <Box marginTop={0}>
            <Text>{muted(`  · max ${max} reached — enter to finish`)}</Text>
          </Box>
        )}
      </Box>

      {topLevelError ? (
        <Box marginTop={1}>
          <Text color="red">{topLevelError}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ navigate · tab next field · enter add/finish (empty row to finish) · backspace clear/delete · esc cancel
        </Text>
        <Text dimColor>
          {`${state.items.length} entr${state.items.length === 1 ? 'y' : 'ies'} · min ${min} · max ${max}`}
        </Text>
      </Box>
    </Box>
  );
};

interface RowProps<T> {
  item: T;
  fields: FieldSpec<T>[];
  focused: boolean;
  /** Which field key is currently being edited inside the focused row. */
  focusedFieldKey: string;
  /** Live text-input value while this row is focused; null otherwise. */
  draft: string | null;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
}

const Row = <T,>({
  item,
  fields,
  focused,
  focusedFieldKey,
  draft,
  setDraft,
  onSubmit,
  error,
}: RowProps<T>) => {
  const cursor = focused ? accent('›') : ' ';
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{cursor} </Text>
        {fields.map((field, i) => {
          const isEditing = focused && field.key === focusedFieldKey;
          const stored = field.extract(item);
          return (
            <Box key={field.key}>
              {i > 0 ? <Text>{muted(' · ')}</Text> : null}
              <Text>{muted(field.label + ': ')}</Text>
              {isEditing && draft !== null ? (
                <TextInput
                  value={draft}
                  onChange={setDraft}
                  onSubmit={onSubmit}
                  placeholder={field.placeholder ?? ''}
                />
              ) : stored.length > 0 ? (
                <Text>{focused ? stored : ok(stored)}</Text>
              ) : (
                <Text>{muted(field.placeholder ?? '(empty)')}</Text>
              )}
            </Box>
          );
        })}
      </Box>
      {error ? (
        <Box marginLeft={2}>
          <Text>{warn('  ' + error)}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
