import { readFile } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { OrchestratorConfigSchema, OrchestratorConfig } from './schema.js';
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
      const validated = OrchestratorConfigSchema.parse(parsed);
      const resolvedConfig: OrchestratorConfig = {
        ...validated,
        logDirectory: this.resolveLogDirectory(validated.logDirectory),
      };
      this.cachedConfig = resolvedConfig;
      logger.info('Loaded orchestrator config', { path: configPath });
      return resolvedConfig;
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

  async validate(): Promise<{ config: OrchestratorConfig }> {
    const config = await this.loadOrchestratorConfig();
    return { config };
  }

  getConfigDir(): string {
    return this.configDir;
  }

  private resolveLogDirectory(dir?: string): string {
    if (!dir || dir.trim().length === 0) {
      return this.configDir;
    }

    const normalized = dir.trim();
    return isAbsolute(normalized) ? normalized : join(this.configDir, normalized);
  }
}
