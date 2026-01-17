#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { startCommand } from './commands/start.js';

const program = new Command();

program
  .name('cco')
  .description(chalk.cyan('Claude Code Orchestrator') + ' - Orchestrate multiple Claude instances using the Agent SDK')
  .version('3.0.0');

// Default command: interactive start or start with config
program
  .command('start', { isDefault: true })
  .description('Start the orchestrator (interactive if no config provided)')
  .option('-c, --config <path>', 'Path to config directory')
  .option('-w, --workspace <path>', 'Path to workspace directory')
  .action(startCommand);

program.parse();
