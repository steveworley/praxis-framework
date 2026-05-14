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
    label: 'criterion',
    placeholder: 'e.g. drafts land in ≤2 review cycles',
    extract: (i) => i.value,
    apply: (i, value) => ({ ...i, value }),
  },
];

const validate = (i: Item): string | null =>
  i.value.trim().length === 0 ? 'criterion is required' : null;

export const SuccessCriteriaFlow = ({ initial, onNext, onCancel }: Props) => (
  <ListBuilder<Item>
    title="Success criteria"
    helper={
      'Observable, falsifiable outcomes — "drafts land in ≤2 review cycles", not "be helpful". The role will use these for end-of-run self-assessment.'
    }
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
