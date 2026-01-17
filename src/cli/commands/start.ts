import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { OrchestratorV3 } from '../../v3/index.js';
import type { V3OrchestratorConfig, AuthConfig } from '../../v3/types.js';
import { ConfigLoader } from '../../config/loader.js';
import { logger, configureLogDirectory } from '../../utils/logger.js';
import { extractRepoName } from '../../utils/repo.js';

interface StartOptions {
  config?: string;
  workspace?: string;
}

/**
 * Interactive prompts for configuration
 */
async function runInteractiveSetup(): Promise<{ configDir: string; workspaceDir: string }> {
  console.log(chalk.cyan('\n Claude Code Orchestrator - Interactive Setup\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'repositoryUrl',
      message: 'Repository URL:',
      validate: (input: string) => {
        if (!input.trim()) return 'Repository URL is required';
        if (!input.match(/^(https?:\/\/|git@)/)) return 'Must be a valid git URL (HTTPS or SSH)';
        return true;
      },
    },
    {
      type: 'input',
      name: 'branch',
      message: 'Branch:',
      default: 'main',
    },
    {
      type: 'number',
      name: 'workerCount',
      message: 'Number of workers:',
      default: 2,
      validate: (input: number) => {
        if (input < 1 || input > 20) return 'Worker count must be between 1 and 20';
        return true;
      },
    },
    {
      type: 'list',
      name: 'authMode',
      message: 'Authentication mode:',
      choices: [
        { name: 'OAuth (use ~/.claude credentials)', value: 'oauth' },
        { name: 'API Keys First (fall back to OAuth)', value: 'api-keys-first' },
        { name: 'API Keys Only', value: 'api-keys-only' },
      ],
      default: 'oauth',
    },
  ]);

  // Create temporary config directory
  const repoName = extractRepoName(answers.repositoryUrl);
  const timestamp = Date.now();
  const configDir = join(tmpdir(), `cco-${repoName}-${timestamp}`);
  const workspaceDir = join(configDir, 'workspace');

  await mkdir(configDir, { recursive: true });

  // Write orchestrator.json
  const config = {
    repositoryUrl: answers.repositoryUrl,
    branch: answers.branch,
    workerCount: answers.workerCount,
    authMode: answers.authMode,
    workspaceDir,
  };

  await writeFile(join(configDir, 'orchestrator.json'), JSON.stringify(config, null, 2));

  console.log(chalk.green(`\n Config created at: ${configDir}`));
  console.log(chalk.gray(`  Workspace will be at: ${workspaceDir}\n`));

  // If api-keys-only, prompt for API key
  if (answers.authMode === 'api-keys-only') {
    const keyAnswer = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter Anthropic API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key is required for api-keys-only mode',
      },
    ]);

    const apiKeys = [{ name: 'api-key-1', apiKey: keyAnswer.apiKey }];
    await writeFile(join(configDir, 'api-keys.json'), JSON.stringify(apiKeys, null, 2));
    console.log(chalk.green(' API key saved'));
  }

  return { configDir, workspaceDir };
}

/**
 * Load auth configs from api-keys.json in config directory.
 */
async function loadAuthConfigs(configDir: string): Promise<AuthConfig[]> {
  const configPath = join(configDir, 'api-keys.json');

  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const data = JSON.parse(content);
    const configs: AuthConfig[] = [];

    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          // Simple string API key
          configs.push({ name: `api-key-${configs.length + 1}`, apiKey: item });
        } else if (item.apiKey) {
          // Object with apiKey field
          configs.push({ name: item.name || `api-key-${configs.length + 1}`, apiKey: item.apiKey });
        } else if (item.env) {
          // Env-based config (e.g., z.ai format)
          configs.push({
            name: item.name || `api-key-${configs.length + 1}`,
            env: item.env,
          });
        }
      }
    }

    return configs;
  } catch (err) {
    logger.warn('Failed to load auth configs', err);
    return [];
  }
}

/**
 * Resolve log base directory from config
 */
async function resolveLogBaseDir(configDir: string): Promise<string> {
  const configPath = join(configDir, 'orchestrator.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const configured = typeof parsed.logDirectory === 'string' ? parsed.logDirectory.trim() : '';
    if (configured.length > 0) {
      return isAbsolute(configured) ? configured : join(configDir, configured);
    }
  } catch {
    // Fall back to config dir
  }
  return configDir;
}

/**
 * Create timestamped run log directory
 */
async function createRunLogDirectory(baseDir: string): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(baseDir, `run-${timestamp}`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Set up signal handlers for graceful shutdown
 */
function setupSignalHandlers(orchestrator: OrchestratorV3): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, forcing exit...');
      process.exit(1);
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
      await orchestrator.stop(signal);
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    logger.error('Uncaught exception', err);
    await orchestrator.stop('uncaughtException');
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error('Unhandled rejection', reason);
    await orchestrator.stop('unhandledRejection');
    process.exit(1);
  });
}

/**
 * Start command handler
 */
export async function startCommand(options: StartOptions): Promise<void> {
  let configDir: string;
  let workspaceDir: string | undefined;

  // If no config provided, run interactive setup
  if (!options.config) {
    const setup = await runInteractiveSetup();
    configDir = setup.configDir;
    workspaceDir = setup.workspaceDir;
  } else {
    configDir = options.config;
    workspaceDir = options.workspace;
  }

  const logBaseDir = await resolveLogBaseDir(configDir);
  const runLogDir = await createRunLogDirectory(logBaseDir);
  configureLogDirectory(runLogDir);

  // Load and validate configuration
  const loader = new ConfigLoader(configDir);
  let config;

  try {
    const validated = await loader.validate();
    config = validated.config;
    config.logDirectory = logBaseDir;

    // Use workspaceDir from config if available, otherwise from CLI, otherwise generate
    if (!workspaceDir) {
      if (config.workspaceDir) {
        workspaceDir = config.workspaceDir;
      } else {
        const repoName = extractRepoName(config.repositoryUrl);
        workspaceDir = join(tmpdir(), `cco-workspace-${repoName}-${Date.now()}`);
      }
    }

    logger.info('Claude Code Orchestrator starting...', {
      configDir,
      workspaceDir,
      runLogDir,
    });

    logger.info('Configuration loaded', {
      repository: config.repositoryUrl,
      branch: config.branch,
      workerCount: config.workerCount,
      engineerManagerGroupSize: config.engineerManagerGroupSize,
      authMode: config.authMode,
    });
  } catch (err) {
    logger.error('Configuration error', err);
    process.exit(1);
  }

  // Load auth configs
  const authConfigs = await loadAuthConfigs(configDir);

  if (config.authMode === 'api-keys-only' && authConfigs.length === 0) {
    logger.error('authMode "api-keys-only" is set but no api-keys.json was found or it is empty');
    process.exit(1);
  }

  if (authConfigs.length > 0) {
    logger.info(`Loaded ${authConfigs.length} auth config(s): ${authConfigs.map((c) => c.name).join(', ')}`);
  } else {
    logger.info('Using OAuth authentication');
  }

  // Build config
  const v3Config: Partial<V3OrchestratorConfig> & Pick<V3OrchestratorConfig, 'repositoryUrl' | 'branch' | 'workspaceDir' | 'projectDirection'> = {
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    workspaceDir: workspaceDir!,
    localRepoPath: config.localRepoPath,
    projectDirection: '', // Will be loaded from PROJECT_DIRECTION.md
    workerCount: config.workerCount,
    engineerManagerGroupSize: config.engineerManagerGroupSize,
    authMode: config.authMode || 'oauth',
    taskTimeoutMs: config.taskTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    maxRunDurationMinutes: config.maxRunDurationMinutes,
    logDirectory: config.logDirectory,
    sessionPersistPath: join(configDir, 'sessions.json'),
    autoResume: true,
    permissionMode: 'bypassPermissions',
    auditLog: true,
    progressIntervalMs: 30000,
  };

  // Create and start orchestrator
  const orchestrator = new OrchestratorV3(v3Config);
  setupSignalHandlers(orchestrator);

  // Forward events to logger with verbose output
  orchestrator.on('tool:start', (event) => {
    logger.info('Tool call', { sessionId: event.data.sessionId, tool: event.data.tool });
  });

  orchestrator.on('task:complete', (event) => {
    logger.info('Task completed', { sessionId: event.data.sessionId, resultLength: event.data.result?.length || 0 });
  });

  orchestrator.on('task:error', (event) => {
    logger.error('Task error', { sessionId: event.data.sessionId, error: event.data.error });
  });

  orchestrator.on('query:start', (event) => {
    logger.info('Query started', { sessionId: event.data.sessionId });
  });

  orchestrator.on('query:message', (event) => {
    logger.debug('Query message', { sessionId: event.data.sessionId, type: event.data.type });
  });

  orchestrator.on('text:stream', (data) => {
    if (data?.text) {
      process.stdout.write(data.text);
    }
  });

  // Progress logging every 30 seconds
  const progressInterval = setInterval(() => {
    const status = orchestrator.getStatus?.() || {};
    logger.info('Progress', status);
  }, 30000);

  try {
    await orchestrator.start();
    clearInterval(progressInterval);
    logger.info('Orchestrator completed');
  } catch (err) {
    clearInterval(progressInterval);
    logger.error('Orchestrator failed', err);
    process.exit(1);
  }
}
