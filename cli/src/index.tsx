#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init.js';

program
  .name('praxis')
  .description('praxis-framework CLI')
  .version('0.0.1');

program
  .command('init')
  .description('set up a new praxis role')
  .option('--path <path>', 'directory to scaffold the role into', process.cwd())
  .action(initCommand);

program.parse();
