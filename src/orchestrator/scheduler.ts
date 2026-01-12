import { logger } from '../utils/logger.js';

export interface Task {
  id: string;
  description: string;
  priority: number;
  assignedTo?: number;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  retryCount: number;
  maxRetries: number;
}

export class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private taskQueue: string[] = [];
  private readonly maxRetries: number;

  constructor(maxRetries: number = 3) {
    this.maxRetries = maxRetries;
  }

  /**
   * Add a new task to the queue.
   */
  addTask(opts: {
    id: string;
    description: string;
    priority?: number;
    maxRetries?: number;
  }): Task {
    const task: Task = {
      id: opts.id,
      description: opts.description,
      priority: opts.priority ?? 0,
      status: 'pending',
      createdAt: new Date(),
      retryCount: 0,
      maxRetries: opts.maxRetries ?? this.maxRetries,
    };

    this.tasks.set(task.id, task);
    this.taskQueue.push(task.id);
    this.sortQueue();

    logger.info(`Task added: ${task.id}`, { priority: task.priority });
    return task;
  }

  /**
   * Get the next available task.
   */
  getNextTask(): Task | undefined {
    const taskId = this.taskQueue.find(
      (id) => this.tasks.get(id)?.status === 'pending'
    );
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  /**
   * Assign a task to a worker.
   */
  assignTask(taskId: string, workerId: number): Task | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'pending') {
      task.assignedTo = workerId;
      task.status = 'assigned';
      task.startedAt = new Date();
      logger.info(`Task ${taskId} assigned to worker ${workerId}`);
      return task;
    }
    return undefined;
  }

  /**
   * Mark a task as in progress.
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'assigned') {
      task.status = 'in_progress';
      logger.debug(`Task ${taskId} in progress`);
    }
  }

  /**
   * Mark a task as completed.
   */
  completeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'completed';
      task.completedAt = new Date();

      // Remove from queue
      const index = this.taskQueue.indexOf(taskId);
      if (index > -1) {
        this.taskQueue.splice(index, 1);
      }

      logger.info(`Task ${taskId} completed`, {
        duration: task.completedAt.getTime() - (task.startedAt?.getTime() ?? task.createdAt.getTime()),
      });
    }
  }

  /**
   * Mark a task as failed and optionally re-queue it.
   */
  failTask(taskId: string, requeue: boolean = true): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.retryCount++;

      if (requeue && task.retryCount < task.maxRetries) {
        task.status = 'pending';
        task.assignedTo = undefined;
        task.startedAt = undefined;
        logger.warn(`Task ${taskId} failed, requeued (retry ${task.retryCount}/${task.maxRetries})`);
      } else {
        task.status = 'failed';
        logger.error(`Task ${taskId} failed permanently after ${task.retryCount} retries`);
      }
    }
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get tasks assigned to a worker.
   */
  getWorkerTasks(workerId: number): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.assignedTo === workerId && t.status !== 'completed' && t.status !== 'failed'
    );
  }

  /**
   * Sort queue by priority (descending).
   */
  private sortQueue(): void {
    this.taskQueue.sort((a, b) => {
      const taskA = this.tasks.get(a)!;
      const taskB = this.tasks.get(b)!;
      return taskB.priority - taskA.priority;
    });
  }

  /**
   * Get count of pending tasks.
   */
  getPendingCount(): number {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'pending').length;
  }

  /**
   * Get statistics about tasks.
   */
  getStats(): {
    total: number;
    pending: number;
    assigned: number;
    inProgress: number;
    completed: number;
    failed: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      assigned: tasks.filter((t) => t.status === 'assigned').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Clear all completed and failed tasks.
   */
  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        this.tasks.delete(id);
        const index = this.taskQueue.indexOf(id);
        if (index > -1) {
          this.taskQueue.splice(index, 1);
        }
      }
    }
    logger.debug('Cleared finished tasks');
  }
}
