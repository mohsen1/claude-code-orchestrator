import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { OrchestratorConfigSchema, OrchestratorConfig, ClaudeSettingsSchema } from './schema.js';
import { logger } from '../utils/logger.js';

export class ConfigLoader {
  private configDir: string;
  private cachedConfig: OrchestratorConfig | null = null;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  async loadOrchestratorConfig(): Promise<OrchestratorConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    const configPath = `${this.configDir}/orchestrator.json`;

    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.cachedConfig = OrchestratorConfigSchema.parse(parsed);
      logger.info('Loaded orchestrator config', { path: configPath });
      return this.cachedConfig;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        throw new Error(`Config file not found: ${configPath}`);
      }
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${configPath}`);
      }
      throw err;
    }
  }

  async loadClaudeConfigs(): Promise<string[]> {
    const config = await this.loadOrchestratorConfig();
    const pattern = config.claudeConfigs.replace('~', process.env.HOME || '');

    const paths = await glob(pattern);

    if (paths.length === 0) {
      throw new Error(`No Claude config files found matching pattern: ${config.claudeConfigs}`);
    }

    logger.info(`Found ${paths.length} Claude config files`, { pattern });
    return paths;
  }

  async validateClaudeConfigs(paths: string[]): Promise<void> {
    const errors: string[] = [];

    for (const path of paths) {
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw);
        ClaudeSettingsSchema.parse(parsed);
        logger.debug(`Validated Claude config: ${path}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${path}: ${message}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Invalid Claude config files:\n${errors.join('\n')}`);
    }

    logger.info(`Validated ${paths.length} Claude config files`);
  }

  async validate(): Promise<{
    config: OrchestratorConfig;
    claudeConfigPaths: string[];
  }> {
    const config = await this.loadOrchestratorConfig();
    const claudeConfigPaths = await this.loadClaudeConfigs();
    await this.validateClaudeConfigs(claudeConfigPaths);

    // Warn if fewer configs than needed for rotation
    const neededConfigs = config.workerCount + 1; // +1 for manager
    if (claudeConfigPaths.length < neededConfigs) {
      logger.warn(
        `Fewer Claude configs (${claudeConfigPaths.length}) than instances (${neededConfigs}) - rate limit rotation may fail`
      );
    }

    return { config, claudeConfigPaths };
  }
}
