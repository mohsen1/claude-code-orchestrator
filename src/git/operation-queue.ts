import { logger } from '../utils/logger.js';

export interface QueuedGitOperation<T = unknown> {
  id: string;
  workDir: string;
  operation: () => Promise<T>;
  priority: 'high' | 'normal' | 'low';
  createdAt: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export interface GitQueueStats {
  pending: number;
  processing: boolean;
  totalProcessed: number;
  totalFailed: number;
  avgWaitMs: number;
  avgProcessMs: number;
}

/**
 * Serializes git operations to prevent lock contention when using worktrees.
 *
 * With bucketed locking:
 * - Each workDir has its own queue (local operations can run in parallel)
 * - Global operations (fetch, push, gc) use a global lock
 *
 * Git worktrees share the .git/objects directory, but index.lock is per-worktree.
 * Only fetch/push/gc need global locking. Local operations (add, commit, status) can
 * run in parallel across different worktrees.
 */
export class GitOperationQueue {
  // Per-workdir queues: map of workDir -> queue
  private workdirQueues: Map<string, QueuedGitOperation[]> = new Map();
  // Global queue for operations that must run serially across everything
  private globalQueue: QueuedGitOperation[] = [];

  private processingWorkdir = new Set<string>();
  private processingGlobal = false;
  private operationId = 0;
  private stats = {
    totalProcessed: 0,
    totalFailed: 0,
    totalWaitMs: 0,
    totalProcessMs: 0,
  };

  private readonly maxQueueSize: number;
  private readonly operationTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(options: {
    maxQueueSize?: number;
    operationTimeoutMs?: number;
    retryDelayMs?: number;
    maxRetries?: number;
  } = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 100;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Queue a git operation for execution.
   *
   * @param workDir - The working directory for the git operation
   * @param operation - The async operation to execute
   * @param options.isGlobal - If true, uses global lock (for fetch, push, gc)
   * @param options.priority - Priority for queue ordering
   * @param options.label - Optional label for logging
   */
  async enqueue<T>(
    workDir: string,
    operation: () => Promise<T>,
    options: { isGlobal?: boolean; priority?: 'high' | 'normal' | 'low'; label?: string } = {}
  ): Promise<T> {
    const { isGlobal = false, priority = 'normal', label } = options;

    const targetQueue = isGlobal ? this.globalQueue : this.getWorkdirQueue(workDir);

    if (targetQueue.length >= this.maxQueueSize) {
      throw new Error(`Git operation queue full (max ${this.maxQueueSize}) for ${isGlobal ? 'global' : workDir}`);
    }

    const id = `git-op-${++this.operationId}`;

    return new Promise<T>((resolve, reject) => {
      const queuedOp: QueuedGitOperation<T> = {
        id,
        workDir,
        operation,
        priority,
        createdAt: Date.now(),
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      // Insert based on priority
      this.insertByPriority(targetQueue, queuedOp as QueuedGitOperation<unknown>, priority);

      logger.debug('Git operation queued', {
        id,
        workDir,
        isGlobal,
        priority,
        label,
        queueLength: targetQueue.length,
      });

      if (isGlobal) {
        this.processGlobalQueue();
      } else {
        this.processWorkdirQueue(workDir);
      }
    });
  }

  private getWorkdirQueue(workDir: string): QueuedGitOperation[] {
    if (!this.workdirQueues.has(workDir)) {
      this.workdirQueues.set(workDir, []);
    }
    return this.workdirQueues.get(workDir)!;
  }

  private insertByPriority(queue: QueuedGitOperation[], op: QueuedGitOperation, priority: string): void {
    if (priority === 'high') {
      // Find first non-high priority item
      const insertIndex = queue.findIndex(q => q.priority !== 'high');
      if (insertIndex === -1) {
        queue.push(op);
      } else {
        queue.splice(insertIndex, 0, op);
      }
    } else if (priority === 'low') {
      queue.push(op);
    } else {
      // Normal priority: insert after high, before low
      const insertIndex = queue.findIndex(q => q.priority === 'low');
      if (insertIndex === -1) {
        queue.push(op);
      } else {
        queue.splice(insertIndex, 0, op);
      }
    }
  }

  /**
   * Process a workdir's queue serially.
   */
  private async processWorkdirQueue(workDir: string): Promise<void> {
    if (this.processingWorkdir.has(workDir)) {
      return;
    }

    const queue = this.getWorkdirQueue(workDir);
    if (queue.length === 0) {
      return;
    }

    this.processingWorkdir.add(workDir);

    try {
      while (queue.length > 0) {
        const op = queue.shift()!;
        await this.executeOperation(op);
      }
    } finally {
      this.processingWorkdir.delete(workDir);
    }
  }

  /**
   * Process the global queue serially.
   */
  private async processGlobalQueue(): Promise<void> {
    if (this.processingGlobal || this.globalQueue.length === 0) {
      return;
    }

    this.processingGlobal = true;

    try {
      while (this.globalQueue.length > 0) {
        const op = this.globalQueue.shift()!;
        await this.executeOperation(op);
      }
    } finally {
      this.processingGlobal = false;
    }
  }

  private async executeOperation(op: QueuedGitOperation): Promise<void> {
    const waitMs = Date.now() - op.createdAt;

    logger.debug('Processing git operation', {
      id: op.id,
      workDir: op.workDir,
      waitMs,
    });

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(op.operation);
        const processMs = Date.now() - startTime;

        this.stats.totalProcessed++;
        this.stats.totalWaitMs += waitMs;
        this.stats.totalProcessMs += processMs;

        logger.debug('Git operation completed', {
          id: op.id,
          attempt,
          processMs,
        });

        op.resolve(result);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.maxRetries && this.isRetryableError(lastError)) {
          logger.warn('Git operation failed, retrying', {
            id: op.id,
            attempt,
            maxRetries: this.maxRetries,
            error: lastError.message,
          });
          await this.delay(this.retryDelayMs * attempt);
        }
      }
    }

    if (lastError) {
      this.stats.totalFailed++;
      logger.error('Git operation failed permanently', {
        id: op.id,
        error: lastError.message,
      });
      op.reject(lastError);
    }

    // Small delay between operations to let git release resources
    await this.delay(50);
  }

  private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Git operation timed out')),
          this.operationTimeoutMs
        )
      ),
    ]);
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('index.lock') ||
      message.includes('another git process') ||
      message.includes('unable to create') ||
      message.includes('file exists') ||
      message.includes('could not write') ||
      message.includes('timed out')
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue statistics.
   */
  getStats(): GitQueueStats {
    const totalPending = this.globalQueue.length +
      Array.from(this.workdirQueues.values()).reduce((sum, q) => sum + q.length, 0);

    const processed = this.stats.totalProcessed || 1;
    return {
      pending: totalPending,
      processing: this.processingGlobal || this.processingWorkdir.size > 0,
      totalProcessed: this.stats.totalProcessed,
      totalFailed: this.stats.totalFailed,
      avgWaitMs: Math.round(this.stats.totalWaitMs / processed),
      avgProcessMs: Math.round(this.stats.totalProcessMs / processed),
    };
  }

  /**
   * Clear pending operations (doesn't affect currently running operation).
   */
  clear(): void {
    let cleared = 0;

    // Clear global queue
    for (const op of this.globalQueue) {
      op.reject(new Error('Git operation queue cleared'));
    }
    cleared += this.globalQueue.length;
    this.globalQueue = [];

    // Clear all workdir queues
    for (const [workDir, queue] of this.workdirQueues.entries()) {
      for (const op of queue) {
        op.reject(new Error('Git operation queue cleared'));
      }
      cleared += queue.length;
      this.workdirQueues.set(workDir, []);
    }

    logger.info('Git operation queue cleared', { cleared });
  }

  /**
   * Get current queue length.
   */
  get length(): number {
    return this.globalQueue.length +
      Array.from(this.workdirQueues.values()).reduce((sum, q) => sum + q.length, 0);
  }
}

// Singleton instance for the orchestrator
let globalQueue: GitOperationQueue | null = null;

export function getGitQueue(options?: ConstructorParameters<typeof GitOperationQueue>[0]): GitOperationQueue {
  if (!globalQueue) {
    globalQueue = new GitOperationQueue(options);
  }
  return globalQueue;
}

export function resetGitQueue(): void {
  if (globalQueue) {
    globalQueue.clear();
    globalQueue = null;
  }
}
