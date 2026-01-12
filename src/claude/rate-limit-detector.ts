import { TmuxManager } from '../tmux/session.js';
import { ClaudeInstanceManager } from './instance.js';
import { logger } from '../utils/logger.js';

/**
 * Patterns to detect rate limit errors in terminal output.
 * Note: Claude Code may not emit a rate_limit hook, so we scrape tmux output.
 * Update these patterns based on actual error messages observed during Phase 0 testing.
 */
const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /429/,
  /too many requests/i,
  /please try again/i,
  /exceeded.*quota/i,
  /temporarily unavailable/i,
  /API rate limit/i,
  /request limit/i,
];

export class RateLimitDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly patterns: RegExp[];

  constructor(
    private tmux: TmuxManager,
    private instanceManager: ClaudeInstanceManager,
    private onRateLimitDetected: (instanceId: string) => Promise<void>,
    customPatterns?: RegExp[]
  ) {
    this.patterns = customPatterns || RATE_LIMIT_PATTERNS;
  }

  start(intervalMs: number = 10000): void {
    if (this.checkInterval) {
      this.stop();
    }

    this.checkInterval = setInterval(() => {
      this.checkAll().catch((err) => {
        logger.error('Rate limit check failed', err);
      });
    }, intervalMs);

    logger.info(`Rate limit detector started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Rate limit detector stopped');
    }
  }

  private async checkAll(): Promise<void> {
    const instances = this.instanceManager.getAllInstances();

    for (const instance of instances) {
      // Only check busy instances
      if (instance.status !== 'busy') continue;

      await this.checkInstance(instance.id, instance.sessionName);
    }
  }

  private async checkInstance(instanceId: string, sessionName: string): Promise<void> {
    try {
      const output = await this.tmux.capturePane(sessionName, 200);

      for (const pattern of this.patterns) {
        if (pattern.test(output)) {
          logger.warn(`Rate limit detected for ${instanceId}`, {
            pattern: pattern.toString(),
          });

          await this.onRateLimitDetected(instanceId);
          break; // Only trigger once per check
        }
      }
    } catch (err) {
      logger.debug(`Failed to check rate limit for ${instanceId}`, err);
    }
  }

  /**
   * Manually check a specific instance for rate limits.
   */
  async checkNow(instanceId: string): Promise<boolean> {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance) return false;

    try {
      const output = await this.tmux.capturePane(instance.sessionName, 200);

      for (const pattern of this.patterns) {
        if (pattern.test(output)) {
          return true;
        }
      }
    } catch {
      // Ignore errors
    }

    return false;
  }

  /**
   * Add a custom pattern to detect.
   */
  addPattern(pattern: RegExp): void {
    this.patterns.push(pattern);
    logger.debug(`Added rate limit pattern: ${pattern.toString()}`);
  }
}
