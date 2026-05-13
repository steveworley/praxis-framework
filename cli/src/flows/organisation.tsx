import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { Organisation } from '../state/form.js';
import { accent, muted, ok } from '../ui/theme.js';

interface Props {
  initial: Partial<Organisation>;
  onNext: (next: Partial<Organisation>) => void;
  onCancel: () => void;
}

type Field =
  | 'name'
  | 'website'
  | 'sector'
  | 'size'
  | 'description'
  | 'moats'
  | 'customer_profile';

const ORDER: Field[] = [
  'name',
  'website',
  'sector',
  'size',
  'description',
  'moats',
  'customer_profile',
];

const PROMPTS: Record<Field, { label: string; hint: string; required: boolean }> = {
  name: {
    label: 'Organisation name',
    hint: 'The legal or trading name of the business',
    required: true,
  },
  website: {
    label: 'Website',
    hint: 'optional — e.g. https://acme.com',
    required: false,
  },
  sector: {
    label: 'Sector',
    hint: 'optional — e.g. SaaS, healthcare, government',
    required: false,
  },
  size: {
    label: 'Size',
    hint: 'pick one',
    required: false,
  },
  description: {
    label: 'Brief description',
    hint: 'optional — one or two sentences about what you do',
    required: false,
  },
  moats: {
    label: 'Moats / differentiators',
    hint: 'optional — what sets you apart',
    required: false,
  },
  customer_profile: {
    label: 'Customer profile',
    hint: 'optional — who buys from you',
    required: false,
  },
};

const SIZE_ITEMS = [
  { label: 'solo (just me)', value: 'solo' as const },
  { label: 'small (2–10)', value: 'small' as const },
  { label: 'mid (11–100)', value: 'mid' as const },
  { label: 'large (101–1000)', value: 'large' as const },
  { label: 'enterprise (1000+)', value: 'enterprise' as const },
];

export const OrganisationFlow = ({ initial, onNext, onCancel }: Props) => {
  const [draft, setDraft] = useState<Partial<Organisation>>({ ...initial });
  const [fieldIdx, setFieldIdx] = useState(0);
  const [textValue, setTextValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const field = ORDER[fieldIdx];

  // Allow Esc to cancel even while a TextInput has focus.
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  if (!field) {
    return null;
  }

  const prompt = PROMPTS[field];

  const advance = (nextDraft: Partial<Organisation>) => {
    setDraft(nextDraft);
    setError(null);
    setTextValue('');
    if (fieldIdx === ORDER.length - 1) {
      onNext(nextDraft);
    } else {
      setFieldIdx(fieldIdx + 1);
    }
  };

  const handleTextSubmit = (value: string) => {
    const trimmed = value.trim();
    if (prompt.required && trimmed.length === 0) {
      setError('This field is required.');
      return;
    }
    const nextDraft: Partial<Organisation> = { ...draft };
    if (trimmed.length === 0) {
      delete nextDraft[field as Exclude<Field, 'size'>];
    } else if (field !== 'size') {
      nextDraft[field] = trimmed;
    }
    advance(nextDraft);
  };

  const handleSizeSelect = (item: { value: Organisation['size'] }) => {
    const nextDraft: Partial<Organisation> = { ...draft, size: item.value };
    advance(nextDraft);
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Step 1 of 3')} — Tell me about your organisation</Text>
      </Box>

      {/* Already-answered fields, shown for context */}
      {ORDER.slice(0, fieldIdx).map((f) => {
        const v = draft[f];
        if (v === undefined || v === '') return null;
        return (
          <Box key={f}>
            <Text>
              {ok('✓')} {muted(PROMPTS[f].label)}: <Text>{String(v)}</Text>
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">?</Text> {prompt.label}{' '}
          <Text dimColor>({prompt.hint})</Text>
        </Text>
        <Box marginTop={0}>
          {field === 'size' ? (
            <SelectInput items={SIZE_ITEMS} onSelect={handleSizeSelect} />
          ) : (
            <Box>
              <Text>{muted('› ')}</Text>
              <TextInput
                value={textValue}
                onChange={setTextValue}
                onSubmit={handleTextSubmit}
                placeholder={prompt.required ? '' : '(leave blank to skip)'}
              />
            </Box>
          )}
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Esc to cancel</Text>
      </Box>
    </Box>
  );
};
