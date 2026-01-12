import { logger } from '../utils/logger.js';

interface ConfigStatus {
  path: string;
  inUse: boolean;
  rateLimited: boolean;
  rateLimitedUntil?: Date;
  assignedTo?: string;
}

export class ConfigRotator {
  private configs: Map<string, ConfigStatus> = new Map();
  private rateLimitCooldownMinutes: number;

  constructor(configPaths: string[], rateLimitCooldownMinutes: number = 60) {
    this.rateLimitCooldownMinutes = rateLimitCooldownMinutes;

    for (const path of configPaths) {
      this.configs.set(path, {
        path,
        inUse: false,
        rateLimited: false,
      });
    }

    logger.info(`ConfigRotator initialized with ${configPaths.length} configs`);
  }

  /**
   * Assign an available config to an instance.
   */
  assignConfig(instanceId: string): string | null {
    // First, check for rate limits that have expired
    this.checkExpiredRateLimits();

    // Find an available config (not in use, not rate limited)
    const available = Array.from(this.configs.values()).find(
      (c) => !c.inUse && !c.rateLimited
    );

    if (!available) {
      logger.warn(`No available configs for ${instanceId}`);
      return null;
    }

    available.inUse = true;
    available.assignedTo = instanceId;

    logger.info(`Assigned config to ${instanceId}`, { path: available.path });
    return available.path;
  }

  /**
   * Release a config when an instance stops using it.
   */
  releaseConfig(configPath: string): void {
    const config = this.configs.get(configPath);
    if (config) {
      config.inUse = false;
      config.assignedTo = undefined;
      logger.debug(`Released config: ${configPath}`);
    }
  }

  /**
   * Mark a config as rate limited.
   */
  markRateLimited(configPath: string, cooldownMinutes?: number): void {
    const config = this.configs.get(configPath);
    if (!config) return;

    const cooldown = cooldownMinutes ?? this.rateLimitCooldownMinutes;
    config.rateLimited = true;
    config.rateLimitedUntil = new Date(Date.now() + cooldown * 60 * 1000);
    config.inUse = false;
    config.assignedTo = undefined;

    logger.warn(`Config rate limited until ${config.rateLimitedUntil.toISOString()}`, {
      path: configPath,
    });
  }

  /**
   * Rotate to a new config for an instance (release current, mark rate limited, assign new).
   */
  rotateConfig(instanceId: string, currentConfigPath: string): string | null {
    // Release and mark current config as rate limited
    this.releaseConfig(currentConfigPath);
    this.markRateLimited(currentConfigPath);

    // Assign a new config
    return this.assignConfig(instanceId);
  }

  /**
   * Check for expired rate limits and reset them.
   */
  private checkExpiredRateLimits(): void {
    const now = new Date();

    for (const config of this.configs.values()) {
      if (config.rateLimited && config.rateLimitedUntil && config.rateLimitedUntil <= now) {
        config.rateLimited = false;
        config.rateLimitedUntil = undefined;
        logger.info(`Config rate limit expired: ${config.path}`);
      }
    }
  }

  /**
   * Get the config assigned to an instance.
   */
  getConfigForInstance(instanceId: string): string | undefined {
    for (const config of this.configs.values()) {
      if (config.assignedTo === instanceId) {
        return config.path;
      }
    }
    return undefined;
  }

  /**
   * Get stats about config availability.
   */
  getStats(): {
    total: number;
    available: number;
    inUse: number;
    rateLimited: number;
  } {
    this.checkExpiredRateLimits();

    const configs = Array.from(this.configs.values());
    return {
      total: configs.length,
      available: configs.filter((c) => !c.inUse && !c.rateLimited).length,
      inUse: configs.filter((c) => c.inUse).length,
      rateLimited: configs.filter((c) => c.rateLimited).length,
    };
  }

  /**
   * Get all config paths.
   */
  getAllPaths(): string[] {
    return Array.from(this.configs.keys());
  }
}
