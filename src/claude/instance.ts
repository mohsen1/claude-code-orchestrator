import { TmuxManager } from '../tmux/session.js';
import { DockerManager } from '../docker/manager.js';
import { logger } from '../utils/logger.js';

export type InstanceType = 'manager' | 'worker';
export type InstanceStatus =
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'merging'
  | 'error'
  | 'stopped';

export interface ClaudeInstance {
  id: string;
  type: InstanceType;
  workerId: number;
  containerName: string;
  sessionName: string;
  status: InstanceStatus;
  currentTask?: string;
  currentTaskFull?: string; // Full task description for context restoration
  configPath: string;
  lastToolUse?: Date; // For heartbeat/stuck detection
  toolUseCount: number; // For cost tracking
  createdAt: Date;
}

export class ClaudeInstanceManager {
  private instances: Map<string, ClaudeInstance> = new Map();

  constructor(
    private _docker: DockerManager,
    private tmux: TmuxManager
  ) {}

  async createInstance(opts: {
    id: string;
    type: InstanceType;
    workerId: number;
    configPath: string;
  }): Promise<ClaudeInstance> {
    const containerName = `claude-${opts.type === 'manager' ? 'manager' : `worker-${opts.workerId}`}`;
    const sessionName = `claude-${opts.id}`;

    const instance: ClaudeInstance = {
      id: opts.id,
      type: opts.type,
      workerId: opts.workerId,
      containerName,
      sessionName,
      status: 'starting',
      configPath: opts.configPath,
      toolUseCount: 0,
      createdAt: new Date(),
    };

    // Create tmux session with docker exec directly
    await this.tmux.createSessionWithContainer(sessionName, containerName);

    instance.status = 'ready';
    this.instances.set(opts.id, instance);

    logger.info(`Created Claude instance: ${opts.id}`, {
      type: opts.type,
      container: containerName,
    });

    return instance;
  }

  async sendPrompt(instanceId: string, prompt: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.status = 'busy';
    instance.currentTask = prompt.substring(0, 100);
    instance.currentTaskFull = prompt;

    await this.tmux.sendKeys(instance.sessionName, prompt);

    logger.debug(`Sent prompt to ${instanceId}`, {
      taskPreview: instance.currentTask,
    });
  }

  /**
   * Get terminal output from instance.
   * WARNING: Do NOT use this for control flow decisions.
   * Use hooks for state changes. This is for logging/debugging only.
   */
  async getOutput(instanceId: string, lines: number = 500): Promise<string> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return this.tmux.capturePane(instance.sessionName, lines);
  }

  async interruptInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    await this.tmux.sendControlKey(instance.sessionName, 'C-c');
    logger.info(`Interrupted instance: ${instanceId}`);
  }

  getInstance(instanceId: string): ClaudeInstance | undefined {
    return this.instances.get(instanceId);
  }

  getAllInstances(): ClaudeInstance[] {
    return Array.from(this.instances.values());
  }

  getInstancesByType(type: InstanceType): ClaudeInstance[] {
    return this.getAllInstances().filter((i) => i.type === type);
  }

  getIdleWorkers(): ClaudeInstance[] {
    return this.getAllInstances().filter(
      (i) => i.type === 'worker' && i.status === 'idle'
    );
  }

  getBusyWorkers(): ClaudeInstance[] {
    return this.getAllInstances().filter(
      (i) => i.type === 'worker' && i.status === 'busy'
    );
  }

  updateStatus(instanceId: string, status: InstanceStatus): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      const oldStatus = instance.status;
      instance.status = status;
      logger.debug(`Instance ${instanceId} status: ${oldStatus} -> ${status}`);
    }
  }

  updateToolUse(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.lastToolUse = new Date();
      instance.toolUseCount++;
    }
  }

  clearTask(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.currentTask = undefined;
      instance.currentTaskFull = undefined;
    }
  }

  /**
   * Lock a worker during merge operations to prevent race conditions.
   */
  lockWorker(workerId: number): void {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance) {
      instance.status = 'merging';
      logger.info(`Locked worker ${workerId} for merge`);
    }
  }

  /**
   * Unlock a worker after merge completes.
   */
  unlockWorker(workerId: number): void {
    const instance = this.instances.get(`worker-${workerId}`);
    if (instance && instance.status === 'merging') {
      instance.status = 'idle';
      logger.info(`Unlocked worker ${workerId}`);
    }
  }

  async destroyInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance) {
      await this.tmux.killSession(instance.sessionName);
      this.instances.delete(instanceId);
      logger.info(`Destroyed instance: ${instanceId}`);
    }
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    for (const id of ids) {
      await this.destroyInstance(id);
    }
  }

  getStats(): {
    total: number;
    byStatus: Record<InstanceStatus, number>;
    totalToolUses: number;
  } {
    const instances = this.getAllInstances();
    const byStatus: Record<InstanceStatus, number> = {
      starting: 0,
      ready: 0,
      busy: 0,
      idle: 0,
      merging: 0,
      error: 0,
      stopped: 0,
    };

    let totalToolUses = 0;

    for (const instance of instances) {
      byStatus[instance.status]++;
      totalToolUses += instance.toolUseCount;
    }

    return {
      total: instances.length,
      byStatus,
      totalToolUses,
    };
  }
}
