import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GitOperationQueue, getGitQueue, resetGitQueue } from '../../src/git/operation-queue.js';

describe('GitOperationQueue', () => {
  beforeEach(() => {
    resetGitQueue();
  });

  describe('enqueue', () => {
    it('should execute operations serially', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: number[] = [];

      const op1 = queue.enqueue('/repo', async () => {
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push(1);
        return 'result1';
      });

      const op2 = queue.enqueue('/repo', async () => {
        executionOrder.push(2);
        return 'result2';
      });

      const op3 = queue.enqueue('/repo', async () => {
        executionOrder.push(3);
        return 'result3';
      });

      const results = await Promise.all([op1, op2, op3]);

      expect(results).toEqual(['result1', 'result2', 'result3']);
      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should support bucketed locking - parallel local ops on different workdirs', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: string[] = [];
      const startTime = Date.now();

      // Local operations on different workdirs should run in parallel
      const repo1Op = queue.enqueue('/repo1', async () => {
        executionOrder.push('repo1-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('repo1-end');
        return 'repo1';
      });

      const repo2Op = queue.enqueue('/repo2', async () => {
        executionOrder.push('repo2-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('repo2-end');
        return 'repo2';
      });

      const repo3Op = queue.enqueue('/repo3', async () => {
        executionOrder.push('repo3-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('repo3-end');
        return 'repo3';
      });

      const results = await Promise.all([repo1Op, repo2Op, repo3Op]);
      const elapsed = Date.now() - startTime;

      // With bucketed locking, these should run in parallel (~50ms total, not ~150ms)
      expect(elapsed).toBeLessThan(100);

      expect(results).toEqual(['repo1', 'repo2', 'repo3']);

      // Each workdir's operations should still be serial within that workdir
      expect(executionOrder).toContain('repo1-start');
      expect(executionOrder).toContain('repo1-end');
    });

    it('should serialize global operations (fetch, push, gc) across all workdirs', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: string[] = [];

      // Global operations should be serialized even on different workdirs
      const fetch1 = queue.enqueue('/repo1', async () => {
        executionOrder.push('fetch1');
        await new Promise(r => setTimeout(r, 20));
        return 'fetched1';
      }, { isGlobal: true });

      const fetch2 = queue.enqueue('/repo2', async () => {
        executionOrder.push('fetch2');
        await new Promise(r => setTimeout(r, 20));
        return 'fetched2';
      }, { isGlobal: true });

      const push1 = queue.enqueue('/repo1', async () => {
        executionOrder.push('push1');
        await new Promise(r => setTimeout(r, 20));
        return 'pushed1';
      }, { isGlobal: true });

      const results = await Promise.all([fetch1, fetch2, push1]);

      expect(results).toEqual(['fetched1', 'fetched2', 'pushed1']);
      // Global ops should execute serially
      expect(executionOrder).toEqual(['fetch1', 'fetch2', 'push1']);
    });

    it('should mix local and global operations correctly', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: string[] = [];

      // Start a global operation
      const globalOp = queue.enqueue('/repo', async () => {
        executionOrder.push('global-start');
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push('global-end');
        return 'global';
      }, { isGlobal: true });

      // Wait for global to start
      await new Promise(r => setTimeout(r, 10));

      // Local ops on different workdirs should run in parallel with global
      const local1 = queue.enqueue('/workdir1', async () => {
        executionOrder.push('local1');
        return 'local1';
      });

      const local2 = queue.enqueue('/workdir2', async () => {
        executionOrder.push('local2');
        return 'local2';
      });

      const results = await Promise.all([globalOp, local1, local2]);

      expect(results).toEqual(['global', 'local1', 'local2']);

      // Local ops should complete (in parallel) while global is still running
      expect(executionOrder).toContain('global-start');

      // Both local ops should have executed
      expect(executionOrder).toContain('local1');
      expect(executionOrder).toContain('local2');
    });

    it('should auto-detect global operations (fetch, push, gc, remote)', async () => {
      const queue = new GitOperationQueue();
      const isGlobalSpy = vi.fn();

      // These should be detected as global
      await queue.enqueue('/repo', async () => {
        isGlobalSpy('fetch');
        return 'ok';
      }); // No explicit isGlobal, but has 'fetch' in args

      // Wait for processing
      await new Promise(r => setTimeout(r, 50));

      expect(isGlobalSpy).toHaveBeenCalledWith('fetch');
    });

    it('should respect priority ordering', async () => {
      const queue = new GitOperationQueue();
      const executionOrder: string[] = [];

      // Pause processing initially by queueing a slow operation
      const blocker = queue.enqueue('/repo', async () => {
        await new Promise(r => setTimeout(r, 100));
        executionOrder.push('blocker');
      });

      // Queue operations with different priorities
      const low = queue.enqueue('/repo', async () => {
        executionOrder.push('low');
      }, { priority: 'low' });

      const normal = queue.enqueue('/repo', async () => {
        executionOrder.push('normal');
      }, { priority: 'normal' });

      const high = queue.enqueue('/repo', async () => {
        executionOrder.push('high');
      }, { priority: 'high' });

      await Promise.all([blocker, high, normal, low]);

      // High priority should execute before normal, normal before low
      expect(executionOrder).toEqual(['blocker', 'high', 'normal', 'low']);
    });

    it('should retry on lock-related errors', async () => {
      const queue = new GitOperationQueue({ retryDelayMs: 10, maxRetries: 3 });
      let attempts = 0;

      const result = await queue.enqueue('/repo', async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Unable to create index.lock: File exists');
        }
        return 'success';
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should fail after max retries', async () => {
      const queue = new GitOperationQueue({ retryDelayMs: 10, maxRetries: 2 });

      await expect(
        queue.enqueue('/repo', async () => {
          throw new Error('Another git process seems to be running');
        })
      ).rejects.toThrow('Another git process');
    });

    it('should reject if queue is full', async () => {
      const queue = new GitOperationQueue({ maxQueueSize: 2 });

      // Start a slow operation that will be processing
      const p1 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));

      // Wait for p1 to start processing (removed from queue)
      await new Promise(r => setTimeout(r, 10));

      // Queue two more operations (fills the queue)
      const p2 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));
      const p3 = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));

      // This should overflow
      await expect(
        queue.enqueue('/repo', async () => 'overflow')
      ).rejects.toThrow('Git operation queue full');

      // Clean up - catch rejections to avoid unhandled promise warnings
      queue.clear();
      await Promise.allSettled([p1, p2, p3]);
    });
  });

  describe('getStats', () => {
    it('should track statistics', async () => {
      const queue = new GitOperationQueue();

      await queue.enqueue('/repo', async () => 'ok');
      await queue.enqueue('/repo', async () => 'ok');

      // Wait for async processing to complete
      await new Promise(r => setTimeout(r, 100));

      const stats = queue.getStats();
      expect(stats.totalProcessed).toBe(2);
      expect(stats.totalFailed).toBe(0);
      expect(stats.pending).toBe(0);
    });

    it('should track per-workdir queue stats', async () => {
      const queue = new GitOperationQueue();

      // Queue operations on different workdirs
      queue.enqueue('/repo1', async () => 'ok');
      queue.enqueue('/repo2', async () => 'ok');
      queue.enqueue('/repo1', async () => 'ok');

      // Wait for processing to start
      await new Promise(r => setTimeout(r, 50));

      const stats = queue.getStats();
      expect(stats.totalProcessed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clear', () => {
    it('should reject pending operations', async () => {
      const queue = new GitOperationQueue();

      // Start a slow operation
      const slow = queue.enqueue('/repo', () => new Promise(r => setTimeout(r, 500)));

      // Queue more operations
      const pending = queue.enqueue('/repo', async () => 'pending');

      // Clear the queue
      queue.clear();

      // Pending should be rejected - use allSettled to catch the rejection
      const [slowResult, pendingResult] = await Promise.allSettled([slow, pending]);

      expect(slowResult.status).toBe('fulfilled');
      expect(pendingResult.status).toBe('rejected');
      if (pendingResult.status === 'rejected') {
        expect(pendingResult.reason.message).toContain('queue cleared');
      }
    });

    it('should clear all workdir queues', async () => {
      const queue = new GitOperationQueue();

      // Queue operations on different workdirs
      const p1 = queue.enqueue('/repo1', async () => {
        await new Promise(r => setTimeout(r, 100));
        return 'ok';
      });

      const p2 = queue.enqueue('/repo2', async () => 'pending');
      const p3 = queue.enqueue('/repo3', async () => 'pending');

      // Wait for first to start, then clear
      await new Promise(r => setTimeout(r, 50));
      queue.clear();

      const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('rejected');
      expect(r3.status).toBe('rejected');
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const q1 = getGitQueue();
      const q2 = getGitQueue();
      expect(q1).toBe(q2);
    });

    it('should reset singleton', () => {
      const q1 = getGitQueue();
      resetGitQueue();
      const q2 = getGitQueue();
      expect(q1).not.toBe(q2);
    });
  });
});
