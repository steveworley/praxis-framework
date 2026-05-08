import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { Form } from '../state/form.js';
import { accent, muted, warn } from '../ui/theme.js';

interface Props {
  title: string;
  form: Form;
  onNext: () => void;
  onCancel: () => void;
}

export const Stub = ({ title, form, onNext, onCancel }: Props) => {
  useInput((input, key) => {
    if (key.return) {
      onNext();
      return;
    }
    if (input === 'q' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent(title)}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{warn('not yet built')} — placeholder during scaffolding.</Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        <Text>{muted('Form state so far:')}</Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            {muted('organisation:')}{' '}
            {Object.keys(form.organisation).length === 0
              ? muted('(empty)')
              : JSON.stringify(form.organisation)}
          </Text>
          <Text>
            {muted('role_definition:')}{' '}
            {Object.keys(form.role_definition).length === 0
              ? muted('(empty)')
              : JSON.stringify(form.role_definition)}
          </Text>
          <Text>
            {muted('path:')} {form.path}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press enter to continue · q to quit</Text>
      </Box>
    </Box>
  );
};
