import { ClaudeInstanceManager } from '../claude/instance.js';
import { TmuxManager } from '../tmux/session.js';
import { logger } from '../utils/logger.js';

const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without tool use
const NUDGE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes - try nudging first

export class StuckDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private stuckThresholdMs: number;
  private nudgedInstances: Set<string> = new Set(); // Track which instances we've nudged

  constructor(
    private instanceManager: ClaudeInstanceManager,
    private onStuck: (instanceId: string) => Promise<void>,
    stuckThresholdMs?: number,
    private tmux?: TmuxManager
  ) {
    this.stuckThresholdMs = stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  }

  /**
   * Set the tmux manager reference (for active intervention).
   */
  setTmuxManager(tmux: TmuxManager): void {
    this.tmux = tmux;
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
   * Check all instances for stuck state with multi-stage intervention.
   */
  private async check(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();
    const now = Date.now();

    for (const instance of instances) {
      // Only check busy instances
      if (instance.status !== 'busy') continue;

      // Initialize lastToolUse if not set (grace period)
      if (!instance.lastToolUse) {
        instance.lastToolUse = new Date();
        continue;
      }

      const idleTime = now - instance.lastToolUse.getTime();

      // STAGE 1: Nudge (2 minutes) - try to auto-answer prompts
      if (idleTime > NUDGE_THRESHOLD_MS && idleTime < this.stuckThresholdMs) {
        if (!this.nudgedInstances.has(instance.id) && this.tmux) {
          await this.tryNudge(instance.id, instance.sessionName);
          this.nudgedInstances.add(instance.id);
        }
        continue;
      }

      // STAGE 2: Hard intervention (threshold reached)
      if (idleTime > this.stuckThresholdMs) {
        logger.warn(
          `Instance ${instance.id} stuck (no activity for ${(idleTime / 60000).toFixed(1)} minutes). Intervening...`
        );

        try {
          // Try Ctrl+C first to break any loops
          if (this.tmux) {
            await this.tmux.sendControlKey(instance.sessionName, 'C-c');
            await new Promise(r => setTimeout(r, 2000));
            // Send Enter to clear prompt
            await this.tmux.sendKeys(instance.sessionName, '', true);
          }

          // Reset timer so we don't spam interventions
          instance.lastToolUse = new Date();
          this.nudgedInstances.delete(instance.id);

          // Notify orchestrator handler
          await this.onStuck(instance.id);
        } catch (err) {
          logger.error(`Failed to handle stuck instance ${instance.id}`, err);
        }
      }
    }
  }

  /**
   * Try to nudge a stuck instance by answering prompts or sending wake-up.
   */
  private async tryNudge(instanceId: string, sessionName: string): Promise<void> {
    if (!this.tmux) return;

    try {
      // Check for confirmation prompts
      const confirmKey = await this.tmux.hasConfirmationPrompt(sessionName);
      if (confirmKey) {
        logger.info(`Instance ${instanceId} waiting for confirmation, sending '${confirmKey}'`);
        if (confirmKey === 'Enter') {
          await this.tmux.sendKeys(sessionName, '', true);
        } else {
          await this.tmux.sendKeys(sessionName, confirmKey, true);
        }
        return;
      }

      // Check if at Claude prompt (waiting for input but nothing sent)
      const atPrompt = await this.tmux.isAtClaudePrompt(sessionName);
      if (atPrompt) {
        logger.debug(`Instance ${instanceId} at Claude prompt, may be waiting for orchestrator`);
        // Don't intervene if at prompt - orchestrator should send next command
        return;
      }

      // Send a space to wake up (in case of rendering issue)
      logger.debug(`Nudging instance ${instanceId} with space`);
      await this.tmux.sendKeys(sessionName, ' ', false);
    } catch (err) {
      logger.debug(`Failed to nudge instance ${instanceId}`, err);
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
