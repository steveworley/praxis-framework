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
    label: 'capability',
    placeholder: 'e.g. drafts cold-outreach emails',
    extract: (i) => i.value,
    apply: (i, value) => ({ ...i, value }),
  },
];

const validate = (i: Item): string | null =>
  i.value.trim().length === 0 ? 'capability is required' : null;

export const CapabilitiesFlow = ({ initial, onNext, onCancel }: Props) => (
  <ListBuilder<Item>
    title="Capabilities"
    helper="What this role is responsible for. Action-shaped."
    initial={initial.map((value) => ({ value }))}
    fields={FIELDS}
    empty={() => ({ value: '' })}
    validate={validate}
    min={1}
    max={10}
    onNext={(items) => onNext(items.map((i) => i.value.trim()))}
    onCancel={onCancel}
  />
);
