import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { accent, muted } from '../ui/theme.js';

type Path = 'research' | 'manual';

interface Props {
  onNext: (path: Path) => void;
  onCancel: () => void;
}

const ITEMS = [
  {
    label: 'Research and design it for me — hand off to Claude Code',
    value: 'research' as const,
  },
  {
    label: 'Define it yourself — walk through voice, capabilities, inhibitions',
    value: 'manual' as const,
  },
];

export const PathChoiceFlow = ({ onNext, onCancel }: Props) => {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Step 3 of 3')} — How should the role be designed?</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          {muted(
            'Pick how much of the design work you want to do yourself versus offload.',
          )}
        </Text>
      </Box>

      <SelectInput items={ITEMS} onSelect={(item) => onNext(item.value)} />

      <Box marginTop={1}>
        <Text dimColor>↑/↓ to choose · enter to confirm · esc to cancel</Text>
      </Box>
    </Box>
  );
};
