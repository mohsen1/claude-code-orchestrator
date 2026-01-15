import chalk from 'chalk';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startCommand } from './start.js';

interface ResumeOptions {
  config?: string;
}

/**
 * Resume command handler
 * 
 * Resumes a paused orchestrator by clearing the pause flag
 * and restarting the orchestrator.
 */
export async function resumeCommand(options: ResumeOptions): Promise<void> {
  console.log(chalk.cyan('\n▶️  Claude Code Orchestrator - Resume\n'));
  
  if (!options.config) {
    console.log(chalk.red('Error: --config is required to identify which orchestrator to resume'));
    console.log(chalk.gray('Usage: cco resume --config <path>'));
    process.exit(1);
  }
  
  const configDir = options.config;
  const stateFile = join(configDir, 'state.json');
  
  // Check if orchestrator.json exists
  if (!existsSync(join(configDir, 'orchestrator.json'))) {
    console.log(chalk.red(`Error: No orchestrator.json found in ${configDir}`));
    process.exit(1);
  }
  
  // Read state file
  let state: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(await readFile(stateFile, 'utf-8'));
    } catch {
      state = {};
    }
  }
  
  // Check if it was paused
  if (!state.paused) {
    console.log(chalk.yellow('Orchestrator was not paused. Starting normally...'));
  } else {
    console.log(chalk.green('✓ Clearing pause state'));
    
    // Clear pause flag
    state.paused = false;
    state.resumedAt = new Date().toISOString();
    await writeFile(stateFile, JSON.stringify(state, null, 2));
  }
  
  // Read workspace from config
  let workspaceDir: string | undefined;
  try {
    const configPath = join(configDir, 'orchestrator.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8'));
    workspaceDir = config.workspaceDir;
  } catch {
    // Will be determined by startCommand
  }
  
  console.log(chalk.gray('  Restarting orchestrator...\n'));
  
  // Start the orchestrator
  await startCommand({ config: configDir, workspace: workspaceDir });
}
