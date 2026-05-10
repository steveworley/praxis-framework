import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Capability, Catalog } from '../lib/catalog.js';
import { accent, muted, ok } from '../ui/theme.js';

// v1: operator picks which optional capabilities to enable. Built-ins
// (always_available in the catalog) are listed for awareness but not
// selectable. v2 will add per-MCP transport / auth-env / docker-image
// prompts; this step's selected names will become the keys for those
// follow-up prompts.

interface Props {
  catalog: Catalog;
  initial: string[];
  onNext: (selected: string[]) => void;
  onCancel: () => void;
}

export const ToolSelection = ({ catalog, initial, onNext, onCancel }: Props) => {
  const optional = useMemo(() => catalog.optional(), [catalog]);
  const builtins = useMemo(() => catalog.builtins(), [catalog]);

  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Pre-check anything in `initial` that's actually in the catalog —
    // silently drop names that aren't (e.g. removed from a future catalog).
    const optionalNames = new Set(optional.map((c) => c.name));
    return new Set(initial.filter((n) => optionalNames.has(n)));
  });

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onNext([...selected]);
      return;
    }
    if (key.upArrow || input === 'k') {
      if (optional.length === 0) return;
      setCursor((c) => (c - 1 + optional.length) % optional.length);
      return;
    }
    if (key.downArrow || input === 'j') {
      if (optional.length === 0) return;
      setCursor((c) => (c + 1) % optional.length);
      return;
    }
    if (input === ' ') {
      const item = optional[cursor];
      if (!item) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.name)) {
          next.delete(item.name);
        } else {
          next.add(item.name);
        }
        return next;
      });
    }
  });

  // Pad the capability name column so the description aligns. Use the
  // longest optional name as the basis — clamps small layouts gracefully.
  const nameWidth = optional.reduce(
    (max, c) => Math.max(max, c.name.length),
    0,
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{accent('Tool capabilities')}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>{muted('Capabilities available to this role.')}</Text>
      </Box>

      {builtins.length > 0 ? (
        <Box marginBottom={1}>
          <Text>
            {muted('Always present:')}{' '}
            <Text>{builtins.map((c) => c.name).join(', ')}</Text>
          </Text>
        </Box>
      ) : null}

      {optional.length === 0 ? (
        <Box marginBottom={1}>
          <Text>{muted('No optional capabilities in the catalog.')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {optional.map((cap, idx) => (
            <Row
              key={cap.name}
              cap={cap}
              checked={selected.has(cap.name)}
              focused={idx === cursor}
              nameWidth={nameWidth}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ to move · space to toggle · enter to confirm · esc to cancel</Text>
      </Box>
    </Box>
  );
};

interface RowProps {
  cap: Capability;
  checked: boolean;
  focused: boolean;
  nameWidth: number;
}

const Row = ({ cap, checked, focused, nameWidth }: RowProps) => {
  const cursor = focused ? accent('›') : ' ';
  const box = checked ? ok('[x]') : '[ ]';
  const namePadded = cap.name.padEnd(nameWidth, ' ');
  return (
    <Box>
      <Text>
        {cursor} {box} <Text>{namePadded}</Text>
        {'  '}
        {muted('· ' + cap.description)}
      </Text>
    </Box>
  );
};
