import React from 'react';
import { Box, Text, useInput } from 'ink';

import type { Form } from '../state/form.js';
import { accent, danger, muted, warn } from '../ui/theme.js';
import { adaptFormToSeedInput } from '../lib/seed-adapter.js';

interface Props {
  form: Form;
  scaffoldPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pre-write summary screen. Shows the form state, validates it against the
 * seed package's schema, and waits for the operator to either confirm
 * (enter) or cancel (esc / q). Keeping confirm in its own step means the
 * actual write happens deterministically without a flicker of the form
 * dump while the seeder runs.
 */
export const Review = ({ form, scaffoldPath, onConfirm, onCancel }: Props) => {
  const validation = adaptFormToSeedInput(form);

  useInput((input, key) => {
    if (key.return && validation.ok) {
      onConfirm();
      return;
    }
    if (input === 'q' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Review')}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          {muted('Target path:')} {accent(scaffoldPath)}
        </Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        <Text>{muted('Captured form:')}</Text>
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
          <Text>
            {muted('tools:')}{' '}
            {form.tools.length === 0 ? muted('(none)') : JSON.stringify(form.tools)}
          </Text>
          <Text>
            {muted('voice_traits:')}{' '}
            {form.voice_traits.length === 0 ? muted('(none)') : JSON.stringify(form.voice_traits)}
          </Text>
          <Text>
            {muted('capabilities:')}{' '}
            {form.capabilities.length === 0 ? muted('(none)') : JSON.stringify(form.capabilities)}
          </Text>
          <Text>
            {muted('accountabilities:')}{' '}
            {form.accountabilities.length === 0
              ? muted('(none)')
              : JSON.stringify(form.accountabilities)}
          </Text>
          <Text>
            {muted('success_criteria:')}{' '}
            {form.success_criteria.length === 0
              ? muted('(none)')
              : JSON.stringify(form.success_criteria)}
          </Text>
          <Text>
            {muted('inhibitions:')}{' '}
            {form.inhibitions.length === 0 ? muted('(none)') : JSON.stringify(form.inhibitions)}
          </Text>
          <Text>
            {muted('initial_verbs:')}{' '}
            {form.initial_verbs.length === 0
              ? muted('(none)')
              : JSON.stringify(form.initial_verbs)}
          </Text>
        </Box>
      </Box>
      {!validation.ok ? (
        <Box marginBottom={1} flexDirection="column">
          <Text>{warn('Cannot write — form has validation issues:')}</Text>
          <Box marginLeft={2} flexDirection="column">
            {validation.issues.map((issue) => (
              <Text key={`${issue.path}:${issue.message}`}>
                {danger(issue.path)} {muted('—')} {issue.message}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {validation.ok ? (
          <Text dimColor>Press enter to write · esc to cancel</Text>
        ) : (
          <Text dimColor>Press esc to cancel</Text>
        )}
      </Box>
    </Box>
  );
};
