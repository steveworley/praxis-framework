import React from 'react';
import { ListBuilder, type FieldSpec } from '../ui/list-builder.js';

interface Item {
  value: string;
}

interface Props {
  initial: string[];
  onNext: (items: string[]) => void;
  onCancel: () => void;
}

const FIELDS: FieldSpec<Item>[] = [
  {
    key: 'value',
    label: 'inhibition',
    placeholder: 'e.g. never quote prices without sign-off',
    extract: (i) => i.value,
    apply: (i, value) => ({ ...i, value }),
  },
];

const validate = (i: Item): string | null =>
  i.value.trim().length === 0 ? 'inhibition is required' : null;

export const InhibitionsFlow = ({ initial, onNext, onCancel }: Props) => (
  <ListBuilder<Item>
    title="Hard inhibitions"
    helper="Things this role must never do. Use sparingly — these are absolute."
    initial={initial.map((value) => ({ value }))}
    fields={FIELDS}
    empty={() => ({ value: '' })}
    validate={validate}
    min={0}
    max={10}
    onNext={(items) => onNext(items.map((i) => i.value.trim()))}
    onCancel={onCancel}
  />
);
