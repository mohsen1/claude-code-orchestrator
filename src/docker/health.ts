import { DockerManager } from './manager.js';
import { logger } from '../utils/logger.js';

interface HealthStatus {
  containerName: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  lastCheck: Date;
  consecutiveFailures: number;
}

export class HealthMonitor {
  private statuses: Map<string, HealthStatus> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private docker: DockerManager,
    private onUnhealthy: (containerName: string) => Promise<void>,
    maxConsecutiveFailures: number = 3
  ) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
  }

  start(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      this.stop();
    }

    this.checkInterval = setInterval(() => {
      this.checkAll().catch((err) => {
        logger.error('Health check failed', err);
      });
    }, intervalMs);

    logger.info(`Health monitor started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Health monitor stopped');
    }
  }

  registerContainer(containerName: string): void {
    this.statuses.set(containerName, {
      containerName,
      status: 'unknown',
      lastCheck: new Date(),
      consecutiveFailures: 0,
    });
    logger.debug(`Registered container for health monitoring: ${containerName}`);
  }

  unregisterContainer(containerName: string): void {
    this.statuses.delete(containerName);
    logger.debug(`Unregistered container from health monitoring: ${containerName}`);
  }

  private async checkAll(): Promise<void> {
    const containers = Array.from(this.statuses.keys());

    await Promise.all(containers.map((name) => this.checkContainer(name)));
  }

  private async checkContainer(containerName: string): Promise<void> {
    const healthStatus = this.statuses.get(containerName);
    if (!healthStatus) return;

    const status = await this.docker.getContainerStatus(containerName);

    healthStatus.lastCheck = new Date();

    if (status === 'running') {
      if (healthStatus.status !== 'healthy') {
        logger.info(`Container ${containerName} is now healthy`);
      }
      healthStatus.status = 'healthy';
      healthStatus.consecutiveFailures = 0;
    } else {
      healthStatus.consecutiveFailures++;
      healthStatus.status = 'unhealthy';

      logger.warn(
        `Container ${containerName} unhealthy (status: ${status}, failures: ${healthStatus.consecutiveFailures})`
      );

      if (healthStatus.consecutiveFailures >= this.maxConsecutiveFailures) {
        logger.error(
          `Container ${containerName} exceeded max failures (${this.maxConsecutiveFailures}), triggering recovery`
        );
        await this.onUnhealthy(containerName);
      }
    }
  }

  getStatus(containerName: string): HealthStatus | undefined {
    return this.statuses.get(containerName);
  }

  getAllStatuses(): HealthStatus[] {
    return Array.from(this.statuses.values());
  }

  getHealthySummary(): { healthy: number; unhealthy: number; unknown: number } {
    const statuses = this.getAllStatuses();
    return {
      healthy: statuses.filter((s) => s.status === 'healthy').length,
      unhealthy: statuses.filter((s) => s.status === 'unhealthy').length,
      unknown: statuses.filter((s) => s.status === 'unknown').length,
    };
  }
}
