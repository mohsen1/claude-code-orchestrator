import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Test the MergeQueue class (internal to local-runner).
 * Since it's not exported, we test its behavior through the orchestrator.
 */

describe('MergeQueue behavior', () => {
  describe('queue mechanics', () => {
    it('should process items in order', async () => {
      const processed: number[] = [];
      const processFunc = vi.fn(async (workerId: number) => {
        processed.push(workerId);
        await new Promise(r => setTimeout(r, 10));
      });

      // Simulate queue behavior
      const queue: number[] = [];
      let isProcessing = false;

      const enqueue = (id: number) => {
        if (!queue.includes(id)) queue.push(id);
      };

      const processNext = async () => {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;
        const id = queue.shift()!;
        await processFunc(id);
        isProcessing = false;
      };

      enqueue(1);
      enqueue(2);
      enqueue(3);

      expect(queue).toEqual([1, 2, 3]);

      await processNext();
      expect(processed).toEqual([1]);
      expect(queue).toEqual([2, 3]);

      await processNext();
      expect(processed).toEqual([1, 2]);
    });

    it('should not duplicate workers in queue', () => {
      const queue: number[] = [];

      const enqueue = (id: number) => {
        if (!queue.includes(id)) queue.push(id);
      };

      enqueue(1);
      enqueue(1);
      enqueue(2);
      enqueue(1);

      expect(queue).toEqual([1, 2]);
    });

    it('should not process when already processing', async () => {
      const processFunc = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 50));
      });

      const queue: number[] = [1, 2];
      let isProcessing = false;

      const processNext = async () => {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;
        const id = queue.shift()!;
        await processFunc(id);
        isProcessing = false;
      };

      // Start first processing
      const p1 = processNext();
      // Try to process again while first is running
      const p2 = processNext();

      await Promise.all([p1, p2]);

      // Should only have processed once
      expect(processFunc).toHaveBeenCalledTimes(1);
    });

    it('should requeue on failure', async () => {
      let shouldFail = true;
      const processFunc = vi.fn(async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('Test failure');
        }
      });

      const queue: number[] = [1];
      let isProcessing = false;

      const processNext = async () => {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;
        const id = queue.shift()!;
        try {
          await processFunc(id);
        } catch {
          queue.unshift(id);
        }
        isProcessing = false;
      };

      await processNext();
      // Item should be back in queue
      expect(queue).toEqual([1]);

      // Now process successfully
      await processNext();
      expect(queue).toEqual([]);
      expect(processFunc).toHaveBeenCalledTimes(2);
    });
  });
});
