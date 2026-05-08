import React from 'react';
import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';

/** Full hero header — used once at welcome to establish presence. */
export const Header = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Gradient name="atlas">
      <BigText text="praxis" font="tiny" />
    </Gradient>
    <Text dimColor> role-based agents that fit your business</Text>
  </Box>
);

interface CompactHeaderProps {
  /** Optional wayfinding context shown after the brand mark, e.g. step name. */
  context?: string;
}

/**
 * Compact persistent header — used on every step after welcome.
 * Single-line brand mark with the same atlas gradient + an optional
 * muted wayfinding string. Keeps the wizard branded without dominating
 * the form below.
 */
export const CompactHeader = ({ context }: CompactHeaderProps) => (
  <Box marginBottom={1}>
    <Gradient name="atlas">
      <Text>praxis</Text>
    </Gradient>
    {context && (
      <Text dimColor>
        {' · '}
        {context}
      </Text>
    )}
  </Box>
);
