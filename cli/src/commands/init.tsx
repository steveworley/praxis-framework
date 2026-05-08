import React from 'react';
import { render } from 'ink';
import { App } from '../app.js';

interface InitOptions {
  path?: string;
}

export const initCommand = (options: InitOptions) => {
  // Ink's useInput requires raw mode, which only works on a real TTY. Refuse
  // to start cleanly when run under CI, piped input, or any non-interactive
  // context — beats letting the React reconciler crash with an obscure
  // "Raw mode is not supported" stack trace.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'praxis init requires an interactive terminal.\n' +
        'Run it from a real shell — not piped, not in CI, not nested in another process.\n',
    );
    process.exit(1);
  }

  const scaffoldPath = options.path ?? process.cwd();
  const { waitUntilExit } = render(<App scaffoldPath={scaffoldPath} />, {
    exitOnCtrlC: true,
  });

  waitUntilExit().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`praxis: ${message}\n`);
    process.exit(1);
  });
};
