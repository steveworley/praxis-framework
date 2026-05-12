#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { LogError, runLog, type LogCommandOptions } from './commands/log.js';

program
  .name('praxis')
  .description('praxis-framework CLI')
  .version('0.0.1');

program
  .command('init')
  .description('set up a new praxis role')
  .option('--path <path>', 'directory to scaffold the role into', process.cwd())
  .option(
    '--config <file>',
    'seed non-interactively from a JSON file matching SeedInput (see cli/examples/sample-role.json)',
  )
  .option('--overwrite', 'overwrite existing files at the target (only with --config)', false)
  .addHelpText(
    'after',
    `
Examples:
  $ praxis init                                          # interactive wizard
  $ praxis init --config ./role.json --path ./my-role    # non-interactive seed
  $ praxis init --config ./role.json --overwrite         # re-seed an existing dir

A sample config lives at cli/examples/sample-role.json — copy and edit it
as a starting template for the non-interactive flow.
`,
  )
  .action(initCommand);

program
  .command('log')
  .description("append a JSONL entry to today's log")
  .option('--campaign <id>', 'campaign id (logs land under campaigns/{id}/logs/)')
  .option('--agent <name>', 'agent / verb name responsible for the action')
  .option('--action <verb>', 'action verb, e.g. email_drafted, decision')
  .option('--prospect <id>', 'prospect id (optional conventional extra)')
  .option('--details <text>', 'short narrative (optional)')
  .option('--subject <text>', 'email/message subject (optional)')
  .option('--echo', 'print the JSON line that was written', false)
  .argument('[extras...]', 'extra key=value pairs to merge into the entry')
  .addHelpText(
    'after',
    `
Examples:
  $ praxis log --campaign=q1-outreach --agent=draft-emails --action=email_drafted
  $ praxis log --campaign=manual-leads --agent=monitor-channels --action=channel_intake \\
      channel=notifications-searchai message_ts=1234.5
`,
  )
  .action(async (extras: string[], options: LogCommandOptions) => {
    try {
      await runLog(options, extras);
    } catch (err: unknown) {
      if (err instanceof LogError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`praxis log: ${message}\n`);
      process.exit(1);
    }
  });

program.parse();
