import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';

import { SeedError, seedRole, type SeedInput, type SeedResult } from '@praxis-framework/seed';

import { accent, danger, muted, ok, warn } from '../ui/theme.js';

interface Props {
  input: SeedInput;
  scaffoldPath: string;
  onExit: () => void;
}

type State =
  | { kind: 'writing' }
  | { kind: 'success'; result: SeedResult }
  | { kind: 'error'; message: string };

/**
 * Runs `seedRole` against the operator-confirmed input, then renders the
 * result. The wizard's terminal step — there's nowhere to go after this
 * but exit. Any keypress closes the app once the seed has resolved.
 */
export const Wrote = ({ input, scaffoldPath, onExit }: Props) => {
  const [state, setState] = useState<State>({ kind: 'writing' });

  useEffect(() => {
    let cancelled = false;
    seedRole(input, scaffoldPath)
      .then((result) => {
        if (!cancelled) setState({ kind: 'success', result });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof SeedError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        setState({ kind: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [input, scaffoldPath]);

  useInput((_input, key) => {
    if (state.kind === 'writing') return;
    if (key.return || key.escape || _input === 'q') onExit();
  });

  if (state.kind === 'writing') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> {muted('Writing role files...')}</Text>
        </Box>
      </Box>
    );
  }

  if (state.kind === 'error') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>{danger('Seed failed.')}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>{warn(state.message)}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            {muted('Target path:')} {accent(scaffoldPath)}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to exit</Text>
        </Box>
      </Box>
    );
  }

  // success
  const { result } = state;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {ok(`Wrote ${result.filesWritten.length} files`)} {muted('to')} {accent(result.targetPath)}
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {result.filesWritten.map((rel) => (
          <Text key={rel}>{muted('+')} {rel}</Text>
        ))}
      </Box>
      {result.filesSkipped.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{warn(`Skipped ${result.filesSkipped.length} pre-existing files:`)}</Text>
          <Box flexDirection="column" marginLeft={2}>
            {result.filesSkipped.map((rel) => (
              <Text key={rel}>{muted('·')} {rel}</Text>
            ))}
          </Box>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>Press enter to exit</Text>
      </Box>
    </Box>
  );
};
