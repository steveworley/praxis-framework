import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { RoleDefinition } from '../state/form.js';
import { accent, muted, ok } from '../ui/theme.js';

interface Props {
  initial: Partial<RoleDefinition>;
  onNext: (next: Partial<RoleDefinition>) => void;
  onCancel: () => void;
}

type Field = 'role_name' | 'working_title' | 'one_sentence_purpose' | 'day_to_day';

const ORDER: Field[] = [
  'role_name',
  'working_title',
  'one_sentence_purpose',
  'day_to_day',
];

const PROMPTS: Record<Field, { label: string; hint: string; required: boolean }> = {
  role_name: {
    label: 'Role name',
    hint: 'a short identifier — e.g. bd, support, account-curator',
    required: true,
  },
  working_title: {
    label: 'Working title',
    hint: 'optional — e.g. "BD Lead", "Customer Success"',
    required: false,
  },
  one_sentence_purpose: {
    label: 'One-sentence purpose',
    hint: 'what this role exists to do',
    required: true,
  },
  day_to_day: {
    label: 'Day-to-day work',
    hint: 'optional — what an average day looks like',
    required: false,
  },
};

export const RoleDefinitionFlow = ({ initial, onNext, onCancel }: Props) => {
  const [draft, setDraft] = useState<Partial<RoleDefinition>>({ ...initial });
  const [fieldIdx, setFieldIdx] = useState(0);
  const [textValue, setTextValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const field = ORDER[fieldIdx];
  if (!field) return null;
  const prompt = PROMPTS[field];

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (prompt.required && trimmed.length === 0) {
      setError('This field is required.');
      return;
    }
    const nextDraft: Partial<RoleDefinition> = { ...draft };
    if (trimmed.length === 0) {
      delete nextDraft[field];
    } else {
      nextDraft[field] = trimmed;
    }
    setDraft(nextDraft);
    setError(null);
    setTextValue('');
    if (fieldIdx === ORDER.length - 1) {
      onNext(nextDraft);
    } else {
      setFieldIdx(fieldIdx + 1);
    }
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Step 2 of 3')} — Define the role</Text>
      </Box>

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
        <Box>
          <Text>{muted('› ')}</Text>
          <TextInput
            value={textValue}
            onChange={setTextValue}
            onSubmit={handleSubmit}
            placeholder={prompt.required ? '' : '(leave blank to skip)'}
          />
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
