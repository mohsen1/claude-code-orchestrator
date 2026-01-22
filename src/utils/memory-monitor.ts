/**
 * Memory Monitor - Monitor and manage process memory usage
 *
 * This module provides memory monitoring with automatic throttling when memory
 * usage gets too high. This helps prevent OOM crashes during high-load scenarios
 * like running 24+ workers in parallel.
 */

import { logger } from './logger.js';
import { logCrash, logSystemState } from './crash-logger.js';

export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  heapUsagePercent: number;
}

export interface MemoryMonitorConfig {
  // Memory thresholds (in MB)
  warningThreshold?: number;   // Default: 1000MB
  criticalThreshold?: number;  // Default: 2000MB
  maximumThreshold?: number;   // Default: 3000MB

  // Check interval (ms)
  checkInterval?: number;       // Default: 30000 (30 seconds)

  // Enable auto-throttling
  enableThrottling?: boolean;   // Default: true
}

export interface ThrottleAction {
  shouldThrottle: boolean;
  reason: string;
  currentMemoryMB: number;
  recommendedWorkerCount?: number;
}

export class MemoryMonitor {
  private config: Required<MemoryMonitorConfig>;
  private intervalId: NodeJS.Timeout | null = null;
  private isThrottled = false;
  private peakMemoryMB = 0;

  constructor(config: MemoryMonitorConfig = {}) {
    this.config = {
      warningThreshold: config.warningThreshold || 1000,
      criticalThreshold: config.criticalThreshold || 2000,
      maximumThreshold: config.maximumThreshold || 3000,
      checkInterval: config.checkInterval || 30000,
      enableThrottling: config.enableThrottling !== false,
    };
  }

  /**
   * Get current memory statistics
   */
  getMemoryStats(): MemoryStats {
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
    const heapTotalMB = memUsage.heapTotal / 1024 / 1024;

    return {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers,
      heapUsedMB: Math.round(heapUsedMB * 100) / 100,
      heapTotalMB: Math.round(heapTotalMB * 100) / 100,
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      heapUsagePercent: Math.round((heapUsedMB / heapTotalMB) * 10000) / 100,
    };
  }

  /**
   * Check if memory is in warning zone
   */
  isMemoryWarning(stats?: MemoryStats): boolean {
    const current = stats || this.getMemoryStats();
    return current.heapUsedMB > this.config.warningThreshold;
  }

  /**
   * Check if memory is in critical zone
   */
  isMemoryCritical(stats?: MemoryStats): boolean {
    const current = stats || this.getMemoryStats();
    return current.heapUsedMB > this.config.criticalThreshold;
  }

  /**
   * Check if memory is at maximum (danger zone)
   */
  isMemoryMaximum(stats?: MemoryStats): boolean {
    const current = stats || this.getMemoryStats();
    return current.heapUsedMB > this.config.maximumThreshold;
  }

  /**
   * Determine if throttling is needed and get recommended action
   */
  checkThrottle(currentWorkerCount: number): ThrottleAction {
    const stats = this.getMemoryStats();
    const currentMemoryMB = stats.heapUsedMB;

    // Update peak
    if (currentMemoryMB > this.peakMemoryMB) {
      this.peakMemoryMB = currentMemoryMB;
    }

    // Maximum threshold - emergency throttling
    if (this.isMemoryMaximum(stats)) {
      logCrash('MEMORY AT MAXIMUM THRESHOLD - EMERGENCY THROTTLE', {
        currentMB: currentMemoryMB,
        maximumMB: this.config.maximumThreshold,
        currentWorkers: currentWorkerCount,
      });

      return {
        shouldThrottle: true,
        reason: `Memory (${currentMemoryMB}MB) exceeds maximum threshold (${this.config.maximumThreshold}MB)`,
        currentMemoryMB,
        recommendedWorkerCount: Math.max(1, Math.floor(currentWorkerCount / 4)),
      };
    }

    // Critical threshold - aggressive throttling
    if (this.isMemoryCritical(stats)) {
      logger.warn('Memory at critical threshold', {
        currentMB: currentMemoryMB,
        criticalMB: this.config.criticalThreshold,
      });

      return {
        shouldThrottle: true,
        reason: `Memory (${currentMemoryMB}MB) exceeds critical threshold (${this.config.criticalThreshold}MB)`,
        currentMemoryMB,
        recommendedWorkerCount: Math.max(2, Math.floor(currentWorkerCount / 2)),
      };
    }

    // Warning threshold - moderate throttling
    if (this.isMemoryWarning(stats)) {
      if (!this.isThrottled) {
        logger.warn('Memory at warning threshold', {
          currentMB: currentMemoryMB,
          warningMB: this.config.warningThreshold,
        });
      }

      return {
        shouldThrottle: true,
        reason: `Memory (${currentMemoryMB}MB) exceeds warning threshold (${this.config.warningThreshold}MB)`,
        currentMemoryMB,
        recommendedWorkerCount: Math.max(4, Math.floor(currentWorkerCount * 0.75)),
      };
    }

    return {
      shouldThrottle: false,
      reason: 'Memory usage is normal',
      currentMemoryMB,
    };
  }

  /**
   * Start periodic memory monitoring
   */
  start(currentWorkerCount = 24): void {
    if (this.intervalId) {
      logger.warn('Memory monitor already started');
      return;
    }

    logger.info('Starting memory monitor', {
      warningThreshold: this.config.warningThreshold,
      criticalThreshold: this.config.criticalThreshold,
      maximumThreshold: this.config.maximumThreshold,
      checkInterval: this.config.checkInterval,
    });

    // Initial check
    this.logMemoryStatus(currentWorkerCount);

    // Periodic checks
    this.intervalId = setInterval(() => {
      this.logMemoryStatus(currentWorkerCount);

      const stats = this.getMemoryStats();

      // Force garbage collection if available (NODE_OPTIONS=--expose-gc)
      if (global.gc) {
        if (this.isMemoryWarning(stats)) {
          logger.debug('Running garbage collection due to high memory');
          global.gc();
        }
      }

      // Log to crash file if critical
      if (this.isMemoryCritical(stats)) {
        logCrash('CRITICAL MEMORY LEVEL DETECTED', {
          heapUsed: stats.heapUsedMB,
          rss: stats.rssMB,
          heapPercent: stats.heapUsagePercent,
          peak: this.peakMemoryMB,
        });
      }

      // Emergency abort if at maximum
      if (this.isMemoryMaximum(stats)) {
        logCrash('MEMORY AT MAXIMUM - EMERGENCY SHUTDOWN IMMINENT');
        logSystemState();

        // Try to free memory by forcing GC
        if (global.gc) {
          global.gc();
        }
      }
    }, this.config.checkInterval);
  }

  /**
   * Stop memory monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Memory monitor stopped', {
        peakMemoryMB: this.peakMemoryMB,
      });
    }
  }

  /**
   * Log current memory status
   */
  logMemoryStatus(currentWorkerCount: number): void {
    const stats = this.getMemoryStats();
    const throttle = this.checkThrottle(currentWorkerCount);

    this.isThrottled = throttle.shouldThrottle;

    logger.info('Memory status', {
      heap: `${stats.heapUsedMB}MB / ${stats.heapTotalMB}MB (${stats.heapUsagePercent}%)`,
      rss: `${stats.rssMB}MB`,
      peak: `${this.peakMemoryMB}MB`,
      throttled: throttle.shouldThrottle,
      recommendedWorkers: throttle.recommendedWorkerCount,
    });
  }

  /**
   * Get peak memory usage
   */
  getPeakMemoryMB(): number {
    return this.peakMemoryMB;
  }

  /**
   * Reset peak memory tracking
   */
  resetPeakMemory(): void {
    this.peakMemoryMB = 0;
  }
}

/**
 * Create a memory monitor with default configuration
 */
export function createMemoryMonitor(config?: MemoryMonitorConfig): MemoryMonitor {
  return new MemoryMonitor(config);
}
