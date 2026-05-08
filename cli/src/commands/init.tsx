import React from 'react';
import { render } from 'ink';
import { App } from '../app.js';

interface InitOptions {
  path?: string;
}

export const initCommand = (options: InitOptions) => {
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
