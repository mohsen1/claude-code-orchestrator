import chalk from 'chalk';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface PauseOptions {
  config?: string;
}

/**
 * Pause command handler
 * 
 * Writes a pause signal file that the orchestrator will detect
 * and gracefully pause operations.
 */
export async function pauseCommand(options: PauseOptions): Promise<void> {
  console.log(chalk.cyan('\n⏸️  Claude Code Orchestrator - Pause\n'));
  
  if (!options.config) {
    console.log(chalk.red('Error: --config is required to identify which orchestrator to pause'));
    console.log(chalk.gray('Usage: cco pause --config <path>'));
    process.exit(1);
  }
  
  const configDir = options.config;
  const stateFile = join(configDir, 'state.json');
  
  // Check if orchestrator.json exists
  if (!existsSync(join(configDir, 'orchestrator.json'))) {
    console.log(chalk.red(`Error: No orchestrator.json found in ${configDir}`));
    process.exit(1);
  }
  
  // Read or create state file
  let state: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(await readFile(stateFile, 'utf-8'));
    } catch {
      state = {};
    }
  }
  
  // Set paused flag
  state.paused = true;
  state.pausedAt = new Date().toISOString();
  
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  
  console.log(chalk.green('✓ Pause signal sent'));
  console.log(chalk.gray('  The orchestrator will pause after current tasks complete.'));
  console.log(chalk.gray(`  State saved to: ${stateFile}`));
  console.log();
  console.log(chalk.white('To resume: cco resume --config ' + configDir));
}
