import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { VoiceTrait } from '../state/form.js';
import { TRAIT_LIBRARY, findTrait, type TraitEntry } from '../lib/traits.js';
import { ListBuilder, type FieldSpec } from '../ui/list-builder.js';
import { accent, danger, muted, ok } from '../ui/theme.js';

/**
 * Voice & personality flow — two stages.
 *
 *   1. Trait cloud — the operator picks 1-8 traits from a curated library.
 *      Mirrors the multi-select pattern in `tools.tsx`: arrows to move,
 *      space to toggle, enter to advance.
 *   2. Per-trait qualifiers — for each selected trait the operator authors
 *      0-5 free-text descriptors that qualify *how* the trait should
 *      manifest. Reuses the generic `ListBuilder` with a single text field.
 *
 * Stage 2 is reached only if stage 1 produced at least one selection;
 * empty-qualifier traits ride out with the trait name and its library
 * description as the persona-render fallback.
 *
 * The split avoids the original ListBuilder's "trait + behaviour pair"
 * shape, which conflated *what* a trait is (a canonical token) with *how*
 * it manifests (free-form qualifier). The new shape lets traits be reused
 * across roles and lets a role keep its qualifier authoring shallow when
 * the library description already says what the operator means.
 */

interface Props {
  initial: VoiceTrait[];
  onNext: (traits: VoiceTrait[]) => void;
  onCancel: () => void;
}

const MIN_TRAITS = 1;
const MAX_TRAITS = 8;
const MAX_QUALIFIERS_PER_TRAIT = 5;

type Stage =
  | { kind: 'select'; selected: string[] }
  | { kind: 'qualify'; selected: string[]; cursor: number };

export const VoiceFlow = ({ initial, onNext, onCancel }: Props) => {
  // Seed the cloud's selection from any prior wizard pass — the previously
  // chosen canonical names map straight to the library, and the per-trait
  // qualifiers ride along under the same `traitsByName` map for stage 2.
  const initialSelected = initial
    .map((t) => t.trait)
    .filter((name) => TRAIT_LIBRARY.some((entry) => entry.name === name));

  const [stage, setStage] = useState<Stage>({
    kind: 'select',
    selected: initialSelected,
  });

  // Authored qualifiers, keyed by trait name. Survives moving between
  // stage 1 and stage 2 (in case the operator backs out of qualifying to
  // adjust the trait set) without losing the work in progress.
  const [qualifiers, setQualifiers] = useState<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const entry of initial) {
      out[entry.trait] = [...entry.qualifiers];
    }
    return out;
  });

  if (stage.kind === 'select') {
    return (
      <TraitCloud
        initialSelected={stage.selected}
        onCancel={onCancel}
        onNext={(selected) => {
          // Drop qualifier entries for traits that were unchecked, but keep
          // any work-in-progress qualifiers for still-selected traits.
          setQualifiers((prev) => {
            const next: Record<string, string[]> = {};
            for (const name of selected) {
              next[name] = prev[name] ?? [];
            }
            return next;
          });
          setStage({ kind: 'qualify', selected, cursor: 0 });
        }}
      />
    );
  }

  // Qualifying stage — one trait at a time. The cursor is always derived
  // from a `selected` array we just built, so an out-of-range cursor would
  // be a bug rather than a user-reachable state; render an error rather
  // than side-effect during render.
  const traitName = stage.selected[stage.cursor];
  if (!traitName) {
    return (
      <Box>
        <Text>{danger('Internal: trait cursor out of range — please cancel and retry.')}</Text>
      </Box>
    );
  }
  const traitEntry = findTrait(traitName);

  return (
    <QualifyTrait
      traitName={traitName}
      traitEntry={traitEntry}
      position={stage.cursor + 1}
      total={stage.selected.length}
      initial={qualifiers[traitName] ?? []}
      onCancel={() => setStage({ kind: 'select', selected: stage.selected })}
      onNext={(next) => {
        setQualifiers((prev) => ({ ...prev, [traitName]: next }));
        if (stage.cursor === stage.selected.length - 1) {
          finalise(stage.selected, { ...qualifiers, [traitName]: next }, onNext);
          return;
        }
        setStage({ ...stage, cursor: stage.cursor + 1 });
      }}
    />
  );
};

function finalise(
  selected: string[],
  qualifiers: Record<string, string[]>,
  onNext: (traits: VoiceTrait[]) => void,
) {
  const out: VoiceTrait[] = selected.map((name) => ({
    trait: name,
    qualifiers: (qualifiers[name] ?? []).map((q) => q.trim()).filter((q) => q.length > 0),
  }));
  onNext(out);
}

// ---------------------------------------------------------------------------
// Stage 1: trait cloud (multi-select)
// ---------------------------------------------------------------------------

interface CloudProps {
  initialSelected: string[];
  onNext: (selected: string[]) => void;
  onCancel: () => void;
}

const TraitCloud = ({ initialSelected, onNext, onCancel }: CloudProps) => {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected),
  );
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (selected.size < MIN_TRAITS) {
        setError(`Pick at least ${MIN_TRAITS} trait.`);
        return;
      }
      // Preserve the canonical library order — the operator's selection set
      // is unordered, but the persona reads better with a predictable order.
      const ordered = TRAIT_LIBRARY.filter((t) => selected.has(t.name)).map(
        (t) => t.name,
      );
      onNext(ordered);
      return;
    }
    if (key.upArrow) {
      if (TRAIT_LIBRARY.length === 0) return;
      setCursor((c) => (c - 1 + TRAIT_LIBRARY.length) % TRAIT_LIBRARY.length);
      return;
    }
    if (key.downArrow) {
      if (TRAIT_LIBRARY.length === 0) return;
      setCursor((c) => (c + 1) % TRAIT_LIBRARY.length);
      return;
    }
    if (input === ' ') {
      const entry = TRAIT_LIBRARY[cursor];
      if (!entry) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.name)) {
          next.delete(entry.name);
        } else if (next.size >= MAX_TRAITS) {
          setError(`At most ${MAX_TRAITS} traits.`);
          return prev;
        } else {
          next.add(entry.name);
        }
        setError(null);
        return next;
      });
    }
  });

  const nameWidth = TRAIT_LIBRARY.reduce(
    (max, t) => Math.max(max, t.name.length),
    0,
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Voice & personality — pick traits')}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {muted(
            `Pick ${MIN_TRAITS}-${MAX_TRAITS} traits that describe how this role should sound. You'll qualify each one in the next step.`,
          )}
        </Text>
      </Box>

      <Box flexDirection="column">
        {TRAIT_LIBRARY.map((entry, idx) => (
          <CloudRow
            key={entry.name}
            entry={entry}
            checked={selected.has(entry.name)}
            focused={idx === cursor}
            nameWidth={nameWidth}
          />
        ))}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text>{danger(error)}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {`↑/↓ to move · space to toggle · enter to continue · esc to cancel · ${selected.size}/${MAX_TRAITS} selected`}
        </Text>
      </Box>
    </Box>
  );
};

interface CloudRowProps {
  entry: TraitEntry;
  checked: boolean;
  focused: boolean;
  nameWidth: number;
}

const CloudRow = ({ entry, checked, focused, nameWidth }: CloudRowProps) => {
  const cursor = focused ? accent('›') : ' ';
  const box = checked ? ok('[x]') : '[ ]';
  const namePadded = entry.name.padEnd(nameWidth, ' ');
  return (
    <Box>
      <Text>
        {cursor} {box} <Text>{namePadded}</Text>
        {'  '}
        {muted('· ' + entry.description)}
      </Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Stage 2: per-trait qualifiers
// ---------------------------------------------------------------------------

interface QualifyProps {
  traitName: string;
  traitEntry: TraitEntry | undefined;
  position: number;
  total: number;
  initial: string[];
  onNext: (qualifiers: string[]) => void;
  onCancel: () => void;
}

interface QualifierRow {
  text: string;
}

const QUALIFIER_FIELDS: FieldSpec<QualifierRow>[] = [
  {
    key: 'text',
    label: 'qualifier',
    placeholder: 'how this trait shows up in practice (or leave blank to skip)',
    extract: (r) => r.text,
    apply: (r, v) => ({ ...r, text: v }),
  },
];

const QualifyTrait = ({
  traitName,
  traitEntry,
  position,
  total,
  initial,
  onNext,
  onCancel,
}: QualifyProps) => {
  const initialRows: QualifierRow[] = initial.map((text) => ({ text }));
  const description = traitEntry?.description ?? null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{muted(`trait ${position} of ${total}`)}</Text>
      </Box>
      <Box>
        <Text>
          {accent('→ ')}
          {accent(traitName)}
        </Text>
      </Box>
      {description ? (
        <Box marginBottom={1}>
          <Text>{muted(description)}</Text>
        </Box>
      ) : (
        <Box marginBottom={1} />
      )}
      <Box marginBottom={1}>
        <Text>
          {muted(
            'Author 0-5 qualifiers describing how this trait should manifest. Leave blank to ride out with the description above.',
          )}
        </Text>
      </Box>

      <ListBuilder<QualifierRow>
        // Remount per trait so the in-progress draft input doesn't bleed
        // across traits — `ListBuilder` seeds its state from `initial` only
        // on first mount, so a parent-driven prop swap alone isn't enough.
        key={traitName}
        title=""
        helper=""
        initial={initialRows}
        fields={QUALIFIER_FIELDS}
        empty={() => ({ text: '' })}
        validate={(r) => (r.text.trim().length === 0 ? 'qualifier text is required' : null)}
        min={0}
        max={MAX_QUALIFIERS_PER_TRAIT}
        onNext={(rows) => onNext(rows.map((r) => r.text.trim()).filter((t) => t.length > 0))}
        onCancel={onCancel}
      />

      <Box marginTop={1}>
        <Text dimColor>
          Tip: enter on the last (or empty) row advances to the next trait. Esc returns to the trait cloud.
        </Text>
      </Box>
    </Box>
  );
};
