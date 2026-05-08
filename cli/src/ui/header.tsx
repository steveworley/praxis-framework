import React from 'react';
import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';

export const Header = () => (
  <Box flexDirection="column" marginBottom={1}>
    <Gradient name="atlas">
      <BigText text="praxis" font="tiny" />
    </Gradient>
    <Text dimColor> role-based agents that fit your business</Text>
  </Box>
);
