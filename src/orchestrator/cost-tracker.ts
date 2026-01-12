import { ClaudeInstanceManager } from '../claude/instance.js';
import { logger } from '../utils/logger.js';

export interface UsageStats {
  totalToolUses: number;
  toolUsesPerInstance: Map<string, number>;
  startTime: Date;
  runDurationMinutes: number;
}

export interface CostLimits {
  maxToolUsesPerInstance: number;
  maxTotalToolUses: number;
  maxRunDurationMinutes: number;
}

export interface LimitCheckResult {
  exceeded: boolean;
  reason?: string;
  stats: UsageStats;
}

export class CostTracker {
  private startTime: Date;
  private limits: CostLimits;
  private warned: Set<string> = new Set();

  constructor(
    private instanceManager: ClaudeInstanceManager,
    limits?: Partial<CostLimits>
  ) {
    this.startTime = new Date();
    this.limits = {
      maxToolUsesPerInstance: limits?.maxToolUsesPerInstance ?? 500,
      maxTotalToolUses: limits?.maxTotalToolUses ?? 2000,
      maxRunDurationMinutes: limits?.maxRunDurationMinutes ?? 120,
    };

    logger.info('Cost tracker initialized', { limits: this.limits });
  }

  /**
   * Get current usage statistics.
   */
  getStats(): UsageStats {
    const instances = this.instanceManager.getAllInstances();
    const toolUsesPerInstance = new Map<string, number>();
    let totalToolUses = 0;

    for (const instance of instances) {
      toolUsesPerInstance.set(instance.id, instance.toolUseCount);
      totalToolUses += instance.toolUseCount;
    }

    const runDurationMinutes = (Date.now() - this.startTime.getTime()) / 60000;

    return {
      totalToolUses,
      toolUsesPerInstance,
      startTime: this.startTime,
      runDurationMinutes,
    };
  }

  /**
   * Check if any limits have been exceeded.
   */
  checkLimits(): LimitCheckResult {
    const stats = this.getStats();

    // Check total tool uses
    if (stats.totalToolUses >= this.limits.maxTotalToolUses) {
      return {
        exceeded: true,
        reason: `Total tool uses (${stats.totalToolUses}) exceeded limit (${this.limits.maxTotalToolUses})`,
        stats,
      };
    }

    // Check run duration
    if (stats.runDurationMinutes >= this.limits.maxRunDurationMinutes) {
      return {
        exceeded: true,
        reason: `Run duration (${stats.runDurationMinutes.toFixed(1)}m) exceeded limit (${this.limits.maxRunDurationMinutes}m)`,
        stats,
      };
    }

    // Check per-instance limits
    for (const [instanceId, count] of stats.toolUsesPerInstance) {
      if (count >= this.limits.maxToolUsesPerInstance) {
        return {
          exceeded: true,
          reason: `Instance ${instanceId} tool uses (${count}) exceeded limit (${this.limits.maxToolUsesPerInstance})`,
          stats,
        };
      }
    }

    return { exceeded: false, stats };
  }

  /**
   * Check limits and warn when approaching thresholds.
   */
  checkAndWarn(warningThreshold: number = 0.8): LimitCheckResult {
    const stats = this.getStats();

    // Warn about total tool uses
    const totalRatio = stats.totalToolUses / this.limits.maxTotalToolUses;
    if (totalRatio >= warningThreshold && !this.warned.has('total')) {
      logger.warn(
        `Approaching total tool use limit: ${stats.totalToolUses}/${this.limits.maxTotalToolUses} (${(totalRatio * 100).toFixed(1)}%)`
      );
      this.warned.add('total');
    }

    // Warn about duration
    const durationRatio = stats.runDurationMinutes / this.limits.maxRunDurationMinutes;
    if (durationRatio >= warningThreshold && !this.warned.has('duration')) {
      logger.warn(
        `Approaching run duration limit: ${stats.runDurationMinutes.toFixed(1)}m/${this.limits.maxRunDurationMinutes}m (${(durationRatio * 100).toFixed(1)}%)`
      );
      this.warned.add('duration');
    }

    // Warn about per-instance limits
    for (const [instanceId, count] of stats.toolUsesPerInstance) {
      const ratio = count / this.limits.maxToolUsesPerInstance;
      if (ratio >= warningThreshold && !this.warned.has(instanceId)) {
        logger.warn(
          `Instance ${instanceId} approaching tool use limit: ${count}/${this.limits.maxToolUsesPerInstance} (${(ratio * 100).toFixed(1)}%)`
        );
        this.warned.add(instanceId);
      }
    }

    return this.checkLimits();
  }

  /**
   * Log current usage statistics.
   */
  logStats(): void {
    const stats = this.getStats();

    logger.info('Usage stats', {
      totalToolUses: stats.totalToolUses,
      runDurationMinutes: stats.runDurationMinutes.toFixed(1),
      perInstance: Object.fromEntries(stats.toolUsesPerInstance),
      limits: this.limits,
    });
  }

  /**
   * Reset warnings (useful when limits are raised).
   */
  resetWarnings(): void {
    this.warned.clear();
  }

  /**
   * Update limits at runtime.
   */
  updateLimits(newLimits: Partial<CostLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
    this.resetWarnings();
    logger.info('Cost limits updated', { limits: this.limits });
  }

  /**
   * Get configured limits.
   */
  getLimits(): CostLimits {
    return { ...this.limits };
  }
}
