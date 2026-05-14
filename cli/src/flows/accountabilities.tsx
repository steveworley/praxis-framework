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
    label: 'accountability',
    placeholder: "e.g. I'm responsible for draft quality before review",
    extract: (i) => i.value,
    apply: (i, value) => ({ ...i, value }),
  },
];

const validate = (i: Item): string | null =>
  i.value.trim().length === 0 ? 'accountability is required' : null;

export const AccountabilitiesFlow = ({ initial, onNext, onCancel }: Props) => (
  <ListBuilder<Item>
    title="Accountabilities"
    helper={
      "First-person \"I'm responsible for…\" bullets. What the role drives toward, not what it can do."
    }
    initial={initial.map((value) => ({ value }))}
    fields={FIELDS}
    empty={() => ({ value: '' })}
    validate={validate}
    min={0}
    max={8}
    onNext={(items) => onNext(items.map((i) => i.value.trim()))}
    onCancel={onCancel}
  />
);
