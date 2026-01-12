import { ClaudeInstanceManager } from '../claude/instance.js';
import { logger } from '../utils/logger.js';

const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without tool use

export class StuckDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private stuckThresholdMs: number;

  constructor(
    private instanceManager: ClaudeInstanceManager,
    private onStuck: (instanceId: string) => Promise<void>,
    stuckThresholdMs?: number
  ) {
    this.stuckThresholdMs = stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  }

  /**
   * Start monitoring for stuck instances.
   */
  start(intervalMs: number = 60000): void {
    if (this.checkInterval) {
      this.stop();
    }

    this.checkInterval = setInterval(() => {
      this.check().catch((err) => {
        logger.error('Stuck detection check failed', err);
      });
    }, intervalMs);

    logger.info(`Stuck detector started (threshold: ${this.stuckThresholdMs}ms, interval: ${intervalMs}ms)`);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Stuck detector stopped');
    }
  }

  /**
   * Check all instances for stuck state.
   */
  private async check(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();
    const now = Date.now();

    for (const instance of instances) {
      // Only check busy instances
      if (instance.status !== 'busy') continue;

      // Skip if no tool use recorded yet (instance just started)
      if (!instance.lastToolUse) continue;

      const idleTime = now - instance.lastToolUse.getTime();

      if (idleTime > this.stuckThresholdMs) {
        logger.warn(
          `Instance ${instance.id} appears stuck (no activity for ${(idleTime / 60000).toFixed(1)} minutes)`
        );

        try {
          await this.onStuck(instance.id);
        } catch (err) {
          logger.error(`Failed to handle stuck instance ${instance.id}`, err);
        }
      }
    }
  }

  /**
   * Manually check a specific instance.
   */
  async checkInstance(instanceId: string): Promise<boolean> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance || instance.status !== 'busy' || !instance.lastToolUse) {
      return false;
    }

    const idleTime = Date.now() - instance.lastToolUse.getTime();
    return idleTime > this.stuckThresholdMs;
  }

  /**
   * Update the stuck threshold.
   */
  setThreshold(thresholdMs: number): void {
    this.stuckThresholdMs = thresholdMs;
    logger.info(`Stuck detector threshold updated: ${thresholdMs}ms`);
  }

  /**
   * Get current threshold.
   */
  getThreshold(): number {
    return this.stuckThresholdMs;
  }
}
