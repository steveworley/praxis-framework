import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Header } from '../ui/header.js';
import { muted, accent } from '../ui/theme.js';

interface Props {
  onNext: () => void;
  onCancel: () => void;
}

export const Welcome = ({ onNext, onCancel }: Props) => {
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
      <Header />
      <Box marginTop={1}>
        <Text>
          {accent('Welcome.')} This wizard sets up a new role for your business.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          You{"'"}ll describe your organisation, the role you want to fill, and
          how you{"'"}d like the role designed.
        </Text>
      </Box>
      <Box marginTop={2}>
        <Text>{muted('Press enter to begin · q to quit')}</Text>
      </Box>
    </Box>
  );
};
