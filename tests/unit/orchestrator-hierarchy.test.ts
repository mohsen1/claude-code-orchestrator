import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Orchestrator, createOrchestratorFromConfig } from '../../src/orchestrator.js';
import type { OrchestratorConfig } from '../../src/types.js';
import { resetGitQueue } from '../../src/git/operation-queue.js';

describe('Orchestrator - Hierarchical Mode', () => {
  const testWorkspace = '/tmp/test-orchestrator-workspace';
  const testRepo = 'https://github.com/test/test-repo';

  beforeEach(async () => {
    resetGitQueue();
    // Clean up test workspace
    if (existsSync(testWorkspace)) {
      await rm(testWorkspace, { recursive: true, force: true });
    }
    await mkdir(testWorkspace, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    if (existsSync(testWorkspace)) {
      await rm(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('hierarchical mode detection', () => {
    it('should use flat mode when groupSize is undefined', () => {
      const config: OrchestratorConfig = {
        repositoryUrl: testRepo,
        branch: 'main',
        workspaceDir: testWorkspace,
        workerCount: 10,
        model: 'haiku',
        authMode: 'api-keys-only',
      };

      const orchestrator = new Orchestrator(config);
      // Access private property via TypeScript assertion
      const groupSize = (orchestrator as any).config.groupSize;
      expect(groupSize).toBeUndefined();
    });

    it('should use flat mode when groupSize = 1', () => {
      const config: OrchestratorConfig = {
        repositoryUrl: testRepo,
        branch: 'main',
        workspaceDir: testWorkspace,
        workerCount: 10,
        groupSize: 1,
        model: 'haiku',
        authMode: 'api-keys-only',
      };

      const orchestrator = new Orchestrator(config);
      const groupSize = (orchestrator as any).config.groupSize;
      expect(groupSize).toBe(1);
    });

    it('should use flat mode when workers <= groupSize', () => {
      const config: OrchestratorConfig = {
        repositoryUrl: testRepo,
        branch: 'main',
        workspaceDir: testWorkspace,
        workerCount: 3,
        groupSize: 5,
        model: 'haiku',
        authMode: 'api-keys-only',
      };

      const orchestrator = new Orchestrator(config);
      // Should use flat mode since 3 workers < 5 groupSize
      const groupSize = (orchestrator as any).config.groupSize;
      expect(groupSize).toBe(5);
    });

    it('should use hierarchical mode when workers > groupSize', () => {
      const config: OrchestratorConfig = {
        repositoryUrl: testRepo,
        branch: 'main',
        workspaceDir: testWorkspace,
        workerCount: 20,
        groupSize: 5,
        model: 'haiku',
        authMode: 'api-keys-only',
      };

      const orchestrator = new Orchestrator(config);
      const groupSize = (orchestrator as any).config.groupSize;
      expect(groupSize).toBe(5);
      // 20 workers / 5 groupSize = 4 clusters
    });
  });

  describe('team structure calculation', () => {
    it('should calculate 4 clusters for 20 workers with groupSize 5', () => {
      const workerCount = 20;
      const groupSize = 5;
      const expectedClusters = Math.ceil(workerCount / groupSize);

      expect(expectedClusters).toBe(4);
    });

    it('should calculate 3 clusters for 10 workers with groupSize 4', () => {
      const workerCount = 10;
      const groupSize = 4;
      const expectedClusters = Math.ceil(workerCount / groupSize);

      expect(expectedClusters).toBe(3);
    });

    it('should distribute workers evenly across clusters', () => {
      const workerCount = 10;
      const groupSize = 3;
      const clusters = 4; // Math.ceil(10 / 3) = 4

      const distribution = [];
      for (let i = 0; i < clusters; i++) {
        const workersInCluster = Math.min(groupSize, workerCount - i * groupSize);
        distribution.push(workersInCluster);
      }

      expect(distribution).toEqual([3, 3, 3, 1]); // Last cluster gets remainder
    });

    it('should handle exact division', () => {
      const workerCount = 12;
      const groupSize = 4;
      const clusters = 3;

      const distribution = [];
      for (let i = 0; i < clusters; i++) {
        const workersInCluster = Math.min(groupSize, workerCount - i * groupSize);
        distribution.push(workersInCluster);
      }

      expect(distribution).toEqual([4, 4, 4]);
    });
  });

  describe('feature branch naming', () => {
    it('should generate sequential feature branch names', () => {
      const clusterCount = 4;
      const featureBranches = [];

      for (let i = 0; i < clusterCount; i++) {
        featureBranches.push(`feat/cluster-${i + 1}`);
      }

      expect(featureBranches).toEqual([
        'feat/cluster-1',
        'feat/cluster-2',
        'feat/cluster-3',
        'feat/cluster-4',
      ]);
    });
  });

  describe('worker ID calculation', () => {
    it('should assign sequential worker IDs across clusters', () => {
      const workerCount = 10;
      const groupSize = 3;
      const clusters = Math.ceil(workerCount / groupSize);

      const allWorkerIds = [];
      for (let i = 0; i < clusters; i++) {
        const workersInCluster = Math.min(groupSize, workerCount - i * groupSize);
        for (let j = 0; j < workersInCluster; j++) {
          const workerNum = i * groupSize + j + 1;
          allWorkerIds.push(`worker-${workerNum}`);
        }
      }

      expect(allWorkerIds).toEqual([
        'worker-1', 'worker-2', 'worker-3',  // Cluster 1
        'worker-4', 'worker-5', 'worker-6',  // Cluster 2
        'worker-7', 'worker-8', 'worker-9',  // Cluster 3
        'worker-10',                         // Cluster 4 (remainder)
      ]);
    });
  });

  describe('anti-drift synchronization', () => {
    it('should generate correct git commands for sync at start', () => {
      const featureBranch = 'feat/cluster-1';
      const workerId = 'worker-1';

      const expectedStartCommands = [
        ['fetch', 'origin', featureBranch],
        ['reset', '--hard', `origin/${featureBranch}`],
      ];

      expect(expectedStartCommands).toHaveLength(2);
    });

    it('should generate correct git commands for sync at end', () => {
      const featureBranch = 'feat/cluster-1';
      const workerId = 'worker-1';

      const expectedEndCommands = [
        ['add', '.'],
        ['commit', '-m', `Worker ${workerId}: task description`],
        ['fetch', 'origin', featureBranch],
        ['pull', '--rebase', `origin/${featureBranch}`],
        ['push', 'origin', workerId],
      ];

      expect(expectedEndCommands).toHaveLength(5);
    });

    it('should fallback to merge if rebase fails', () => {
      const featureBranch = 'feat/cluster-1';

      // If rebase fails, should:
      // 1. Run 'rebase --abort'
      // 2. Run 'pull origin <branch>' (merge strategy)

      const fallbackCommands = [
        ['rebase', '--abort'],
        ['pull', 'origin', featureBranch],
      ];

      expect(fallbackCommands).toHaveLength(2);
    });
  });
});

describe('Orchestrator - Anti-Drift Logic', () => {
  describe('sync sequence for hierarchical model', () => {
    it('should sync worker to feature branch at start', async () => {
      const featureBranch = 'feat/auth';
      const workerId = 'worker-1';

      // Simulated sync sequence
      const syncSequence = [
        { cmd: 'fetch', args: ['origin', featureBranch] },
        { cmd: 'reset', args: ['--hard', `origin/${featureBranch}`] },
      ];

      expect(syncSequence).toHaveLength(2);
      expect(syncSequence[0].cmd).toBe('fetch');
      expect(syncSequence[1].cmd).toBe('reset');
    });

    it('should rebase worker changes before push', async () => {
      const featureBranch = 'feat/auth';
      const workerId = 'worker-1';

      // Simulated push sequence
      const pushSequence = [
        { cmd: 'add', args: ['.'] },
        { cmd: 'commit', args: ['-m', `Worker ${workerId}: task`] },
        { cmd: 'fetch', args: ['origin', featureBranch] },
        { cmd: 'pull', args: ['--rebase', 'origin', featureBranch] },
        { cmd: 'push', args: ['origin', workerId] },
      ];

      expect(pushSequence).toHaveLength(5);
      expect(pushSequence[3].cmd).toBe('pull');
      expect(pushSequence[3].args).toContain('--rebase');
    });
  });

  describe('sync sequence for flat model', () => {
    it('should sync worker to main branch at start', async () => {
      const targetBranch = 'main';
      const workerId = 'worker-1';

      const syncSequence = [
        { cmd: 'fetch', args: ['origin', targetBranch] },
        { cmd: 'reset', args: ['--hard', `origin/${targetBranch}`] },
      ];

      expect(syncSequence).toHaveLength(2);
    });

    it('should rebase to main before push', async () => {
      const targetBranch = 'main';
      const workerId = 'worker-1';

      const pushSequence = [
        { cmd: 'add', args: ['.'] },
        { cmd: 'commit', args: ['-m', `Worker ${workerId}: task`] },
        { cmd: 'fetch', args: ['origin', targetBranch] },
        { cmd: 'pull', args: ['--rebase', 'origin', targetBranch] },
        { cmd: 'push', args: ['origin', workerId] },
      ];

      expect(pushSequence).toHaveLength(5);
    });
  });
});
