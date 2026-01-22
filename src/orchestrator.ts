/**
 * Orchestrator - Agent SDK Based
 *
 * Simplified Lead/Worker architecture:
 * - Lead: Coordinates work, read-only access to main repo
 * - Workers: Parallel implementers, each with own worktree
 */

import { EventEmitter } from 'events';
import { join, dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdir, readFile, rm } from 'fs/promises';
import { SessionManager, type SessionManagerConfig } from './session-manager.js';
import {
  createArchitectAgent,
  createTechLeadAgent,
  createWorkerAgent,
  createWorkerAgents,
  type AgentDefinition,
} from './agents.js';
import { createDefaultHooks, type HooksConfig } from './hooks.js';
import { runGit, isGitWorkDirClean, getUncommittedFiles } from './git/safety.js';
import type {
  OrchestratorConfig,
  OrchestratorStatus,
  OrchestratorState,
  OrchestratorEvent,
  Session,
  TeamStructure,
  TeamCluster,
  AuthConfig,
  TaskResult,
} from './types.js';
import { logger, configureLogDirectory } from './utils/logger.js';

// ─────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<OrchestratorConfig> = {
  workerCount: 2,
  model: 'opus',
  autoResume: true,
  permissionMode: 'bypassPermissions',
  taskTimeoutMs: 600000, // 10 minutes
  pollIntervalMs: 5000,
  maxRunDurationMinutes: 480,
  authMode: 'oauth',
  auditLog: true,
  progressIntervalMs: 30000,
};

// ─────────────────────────────────────────────────────────────
// Orchestrator Implementation
// ─────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  private config: OrchestratorConfig;
  private sessionManager: SessionManager;
  private state: OrchestratorState = 'idle';
  private startedAt?: Date;
  private hooks: HooksConfig;

  // Team structure
  private teamStructure?: TeamStructure;

  // Git state
  private repoPath?: string;
  private workBranch?: string; // Branch where workers merge to (may differ from config.branch if useRunBranch=true)

  // API keys
  private apiKeys: AuthConfig[] = [];

  // Stats
  private stats = {
    commits: 0,
    merges: 0,
    conflicts: 0,
  };

  constructor(config: Partial<OrchestratorConfig> & Pick<OrchestratorConfig, 'repositoryUrl' | 'branch' | 'workspaceDir' | 'projectDirection'>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as OrchestratorConfig;

    // Extract API keys from config
    this.apiKeys = this.config.apiKeys || [];

    // Configure logger directory
    configureLogDirectory(this.config.logDirectory || join(this.config.workspaceDir, 'logs'));

    // Initialize hooks
    this.hooks = createDefaultHooks(this);

    // Initialize session manager
    const sessionConfig: Partial<SessionManagerConfig> = {
      persistPath: this.config.sessionPersistPath ||
        join(dirname(this.config.workspaceDir), 'sessions.json'),
      apiKeys: this.apiKeys,
      authMode: this.config.authMode,
      permissionMode: this.config.permissionMode,
      env: this.config.env, // Pass orchestrator env to all sessions
    };
    this.sessionManager = new SessionManager(sessionConfig);

    // Forward session manager events
    this.forwardSessionEvents();
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start orchestrator in state: ${this.state}`);
    }

    this.state = 'running';
    this.startedAt = new Date();

    logger.info('Starting Orchestrator', {
      workerCount: this.config.workerCount,
      branch: this.config.branch,
      model: this.config.model,
    });

    this.emitEvent('orchestrator:start', { config: this.config });

    try {
      // 1. Setup workspace
      await this.setupWorkspace();

      // 2. Load API keys if configured
      await this.loadApiKeys();

      // 3. Setup repository
      await this.setupRepository();

      // 4. Try to resume previous session if configured
      if (this.config.autoResume) {
        const resumed = await this.sessionManager.loadState();
        if (resumed) {
          logger.info('Resumed previous session state');
        }
      }

      // 5. Create team structure
      await this.createTeamStructure();

      // 6. Run the main orchestration
      await this.runOrchestration();

    } catch (error) {
      this.state = 'stopped';
      logger.error('Orchestrator failed', { error });
      throw error;
    }
  }

  /**
   * Stop the orchestrator
   */
  async stop(reason = 'User requested'): Promise<void> {
    logger.info('Stopping orchestrator', { reason });
    this.state = 'stopped';

    // Save session state
    await this.sessionManager.saveState();

    this.emitEvent('orchestrator:stop', { reason });
    this.sessionManager.dispose();
  }

  /**
   * Pause the orchestrator
   */
  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
      logger.info('Orchestrator paused');
      this.emitEvent('orchestrator:pause', {});
    }
  }

  /**
   * Resume from pause
   */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      logger.info('Orchestrator resumed');
      this.emitEvent('orchestrator:resume', {});
    }
  }

  /**
   * Continue the orchestration with new instructions
   * This is the key feature - session continuity!
   */
  async continue(prompt: string): Promise<void> {
    if (!this.teamStructure) {
      throw new Error('No team structure - orchestrator not started');
    }

    const architectSession = this.teamStructure.architect;

    if (!architectSession) {
      throw new Error('No architect session found');
    }

    logger.info('Continuing orchestration with new prompt', {
      sessionId: architectSession.id,
      promptLength: prompt.length,
    });

    // Create worker agents for delegation
    const agents = createWorkerAgents(this.config.workerCount);

    // Execute continuation on the architect session
    for await (const message of this.sessionManager.executeTask(
      architectSession.id,
      prompt,
      {
        allowedTools: ['Read', 'Glob', 'Grep', 'Task'],
        agents,
        model: this.config.model,
      }
    )) {
      this.handleMessage(architectSession.id, message);
    }
  }

  /**
   * Get current status
   */
  getStatus(): OrchestratorStatus {
    const sessionStats = this.sessionManager.getStats();

    return {
      state: this.state,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      workerCount: this.config.workerCount,
      sessions: {
        total: sessionStats.sessionsTotal,
        active: sessionStats.sessionsActive,
        idle: sessionStats.sessionsIdle,
        completed: sessionStats.sessionsCompleted,
        failed: sessionStats.sessionsFailed,
      },
      tasks: {
        completed: sessionStats.tasksCompleted,
        pending: sessionStats.tasksPending,
        failed: sessionStats.tasksFailed,
      },
      git: this.stats,
    };
  }

  /**
   * Get the team structure
   */
  getTeamStructure(): TeamStructure | undefined {
    return this.teamStructure;
  }

  // ─────────────────────────────────────────────────────────────
  // Setup Methods
  // ─────────────────────────────────────────────────────────────

  private async setupWorkspace(): Promise<void> {
    const workspaceDir = this.config.workspaceDir;

    if (!existsSync(workspaceDir)) {
      await mkdir(workspaceDir, { recursive: true });
    }

    logger.info('Workspace setup complete', { workspaceDir });
  }

  private async loadApiKeys(): Promise<void> {
    if (this.config.authMode === 'oauth') {
      return;
    }

    // Try to load api-keys.json from config directory
    const possiblePaths = [
      join(dirname(this.config.workspaceDir), 'api-keys.json'),
      join(this.config.workspaceDir, 'api-keys.json'),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        try {
          const content = await readFile(path, 'utf-8');
          this.apiKeys = JSON.parse(content);
          logger.info('Loaded API keys', { count: this.apiKeys.length });
          break;
        } catch (error) {
          logger.warn('Failed to load API keys', { path, error });
        }
      }
    }
  }

  private async setupRepository(): Promise<void> {
    const { repositoryUrl, branch, workspaceDir, localRepoPath } = this.config;
    this.repoPath = join(workspaceDir, 'repo');

    if (existsSync(this.repoPath)) {
      // Pull latest
      logger.info('Repository exists, pulling latest');
      await runGit(this.repoPath, ['fetch', 'origin']);
      await runGit(this.repoPath, ['checkout', branch]);

      // Try pull, but handle unrelated histories gracefully
      const pullResult = await runGit(this.repoPath, ['pull', 'origin', branch], { allowFailure: true });
      if (pullResult.failed && String(pullResult.stderr || '').includes('unrelated histories')) {
        logger.warn('Unrelated histories detected, resetting to origin/' + branch);
        await runGit(this.repoPath, ['reset', '--hard', `origin/${branch}`]);
      }
    } else if (localRepoPath) {
      // Copy from local path (faster than cloning)
      logger.info('Copying repository from local path', { localRepoPath, branch });
      const { execa } = await import('execa');

      // Create the target directory
      await mkdir(this.repoPath, { recursive: true });

      // Use rsync to copy (note: excludes node_modules for speed)
      await execa('rsync', [
        '-aH',
        '--exclude', '.orchestrator',
        '--exclude', 'node_modules',
        `${localRepoPath}/`,
        `${this.repoPath}/`,
      ]);

      // Reset any changes from rsync excludes and checkout the desired branch
      await runGit(this.repoPath, ['reset', '--hard', 'HEAD'], { allowFailure: true });
      await runGit(this.repoPath, ['checkout', '--force', branch]);
      await runGit(this.repoPath, ['pull', 'origin', branch], { allowFailure: true });
    } else {
      // Clone
      logger.info('Cloning repository', { repositoryUrl, branch });

      const { execa } = await import('execa');

      const cloneOpts = this.config.gitCloneOptions;
      const buildCloneArgs = (usePartial: boolean): string[] => {
        const args = [
          '-c', 'http.lowSpeedLimit=0',
          '-c', 'http.lowSpeedTime=999999',
          '-c', 'http.postBuffer=524288000',
          'clone',
          '--branch',
          branch,
          '--no-tags',
        ];
        if (cloneOpts?.depth) {
          args.push('--depth', String(cloneOpts.depth));
        } else if (usePartial) {
          // Shallow + partial clone fallback for large repos
          args.push('--depth', '1');
        }
        if (cloneOpts?.singleBranch || usePartial) {
          args.push('--single-branch');
        }
        if (cloneOpts?.noSubmodules) {
          args.push('--no-recurse-submodules');
        }
        if (usePartial) {
          args.push('--filter=blob:none');
        }
        args.push(repositoryUrl, this.repoPath!);
        return args;
      };

      const attemptClone = async (usePartial: boolean, attempt: number): Promise<void> => {
        logger.info('Cloning repository (attempt)', { attempt, usePartial });
        try {
          await execa('git', buildCloneArgs(usePartial), {
            cwd: workspaceDir,
            timeout: 900000, // 15 minutes for large repos
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: '0',
              GIT_ASKPASS: '/usr/bin/true',
              GIT_CREDENTIAL_HELPER: '',
              GCM_INTERACTIVE: 'Never',
              GIT_LFS_SKIP_SMUDGE: '1',
            },
          });
        } catch (error) {
          // Clean up partial clone directory before retry
          if (existsSync(this.repoPath!)) {
            await rm(this.repoPath!, { recursive: true, force: true });
          }
          throw error;
        }
      };

      const preferPartial = !cloneOpts?.depth;
      try {
        await attemptClone(preferPartial, 1);
        if (!preferPartial) {
          return;
        }
      } catch (error) {
        logger.warn('Clone failed, retrying with alternate mode', { error });
        try {
          await attemptClone(!preferPartial, 2);
        } catch (error2) {
          logger.warn('Clone retry failed, retrying once more', { error: error2 });
          await this.sleep(5000);
          await attemptClone(true, 3);
        }
      }
    }

    // Set up the work branch (either same as source branch, or a new run branch)
    if (this.config.useRunBranch) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.workBranch = `run-${timestamp}`;

      await runGit(this.repoPath, ['checkout', '-b', this.workBranch]);
      await runGit(this.repoPath, ['push', '-u', 'origin', this.workBranch]);

      logger.info('Created run branch', { workBranch: this.workBranch, sourceBranch: branch });
    } else {
      this.workBranch = branch;
    }

    logger.info('Repository setup complete', { repoPath: this.repoPath, workBranch: this.workBranch });
  }

  private async createTeamStructure(): Promise<void> {
    const groupSize = this.config.groupSize;
    const workerCount = this.config.workerCount;

    // Determine if we should use hierarchical model
    const useHierarchical = groupSize !== undefined && groupSize > 1 && workerCount > groupSize;

    logger.info('Creating team structure', {
      workerCount,
      groupSize: groupSize || 'N/A (flat model)',
      mode: useHierarchical ? 'hierarchical' : 'flat',
    });

    if (useHierarchical) {
      // Hierarchical model: Architect → Tech Leads → Workers
      await this.createHierarchicalTeamStructure(workerCount, groupSize!);
    } else {
      // Flat model: Lead → Workers
      await this.createFlatTeamStructure(workerCount);
    }
  }

  private async createHierarchicalTeamStructure(workerCount: number, groupSize: number): Promise<void> {
    // Calculate number of clusters (Tech Leads)
    const clusterCount = Math.ceil(workerCount / groupSize);
    const clusters: TeamCluster[] = [];

    // Create Architect session (runs in main repo with read-only tools)
    let architect = this.sessionManager.getSession('architect');
    if (!architect) {
      architect = await this.sessionManager.createSession(
        'architect',
        'architect',
        this.repoPath,
        this.workBranch!
      );
    }

    // Create Tech Lead sessions and their workers
    for (let i = 0; i < clusterCount; i++) {
      const leadId = `lead-${i + 1}`;
      const workersInCluster = Math.min(groupSize, workerCount - i * groupSize);

      // Create feature branch for this cluster
      const featureBranch = `feat/cluster-${i + 1}`;

      // Create Tech Lead session (runs in feature branch with read-only tools)
      let techLead = this.sessionManager.getSession(leadId);
      if (!techLead) {
        // Create the feature branch first
        await runGit(this.repoPath!, ['checkout', '-b', featureBranch, this.workBranch!], { allowFailure: true });
        await runGit(this.repoPath!, ['push', '-u', 'origin', featureBranch], { allowFailure: true });
        await runGit(this.repoPath!, ['checkout', this.workBranch!]);

        // Create tech lead session on the feature branch
        techLead = await this.sessionManager.createSession(
          leadId,
          'tech-lead',
          this.repoPath,
          featureBranch
        );
      }

      // Create Worker sessions for this cluster
      const workers: Session[] = [];
      for (let j = 0; j < workersInCluster; j++) {
        const workerNum = i * groupSize + j + 1;
        const workerId = `worker-${workerNum}`;
        let worker = this.sessionManager.getSession(workerId);
        if (!worker) {
          // Create worktree off the feature branch
          const workerPath = await this.createWorktree(workerId, featureBranch);
          worker = await this.sessionManager.createSession(
            workerId,
            'worker',
            workerPath,
            workerId
          );
        }
        workers.push(worker);
      }

      clusters.push({
        lead: techLead,
        featureBranch,
        workers,
      });
    }

    this.teamStructure = {
      architect,
      clusters,
    };

    logger.info('Hierarchical team structure created', {
      architect: architect.id,
      clusters: clusters.map(c => ({
        lead: c.lead.id,
        featureBranch: c.featureBranch,
        workers: c.workers.map(w => w.id),
      })),
    });
  }

  private async createFlatTeamStructure(workerCount: number): Promise<void> {
    // For now, use a single cluster with the architect as the lead
    // This allows backward compatibility while we transition

    // Create Architect session (acts as lead in flat model)
    let architect = this.sessionManager.getSession('architect');
    if (!architect) {
      architect = await this.sessionManager.createSession(
        'architect',
        'architect',
        this.repoPath,
        this.workBranch!
      );
    }

    // Create Worker sessions (each has own worktree)
    const workers: Session[] = [];
    for (let i = 1; i <= workerCount; i++) {
      const workerId = `worker-${i}`;
      let worker = this.sessionManager.getSession(workerId);
      if (!worker) {
        const workerPath = await this.createWorktree(workerId, this.workBranch!);
        worker = await this.sessionManager.createSession(
          workerId,
          'worker',
          workerPath,
          workerId
        );
      }
      workers.push(worker);
    }

    // Create a single cluster
    this.teamStructure = {
      architect,
      clusters: [
        {
          lead: architect, // In flat mode, architect acts as the lead
          featureBranch: this.workBranch!,
          workers,
        },
      ],
    };

    logger.info('Flat team structure created', {
      architect: architect.id,
      workers: workers.map((w: Session) => w.id),
    });
  }

  private async createWorktree(name: string, branch: string): Promise<string> {
    // Use absolute path to avoid git interpreting it relative to repo directory
    const worktreePath = resolve(join(this.config.workspaceDir, 'worktrees', name));

    if (existsSync(worktreePath)) {
      // Worktree exists, just return the path
      return worktreePath;
    }

    // Create branch and worktree (operations are serialized via GitOperationQueue)
    // Prune any stale worktrees first
    await runGit(this.repoPath!, ['worktree', 'prune'], { allowFailure: true });

    // Create or checkout branch
    await runGit(this.repoPath!, ['branch', name, branch], { allowFailure: true });

    // Create worktree (use -f to force if already registered)
    await runGit(this.repoPath!, ['worktree', 'add', '-f', worktreePath, name]);

    // NOTE: We don't push immediately to reduce remote noise
    // Worker branches are pushed when they have actual commits

    logger.info('Created worktree', { name, path: worktreePath, fromBranch: branch });

    return worktreePath;
  }

  /**
   * Validate and clean git state before merge/checkout operations
   * Prevents "uncommitted changes would be overwritten" errors
   */
  private async ensureCleanGitState(operation: string): Promise<void> {
    if (!this.repoPath) {
      throw new Error('Repository path not set');
    }

    const isClean = await isGitWorkDirClean(this.repoPath);

    if (!isClean) {
      const uncommittedFiles = await getUncommittedFiles(this.repoPath);

      logger.warn(`Git state not clean before ${operation}, cleaning up`, {
        fileCount: uncommittedFiles.length,
        files: uncommittedFiles.slice(0, 10),
      });

      // Try to reset to clean state
      try {
        // Abort any merge in progress
        await runGit(this.repoPath, ['merge', '--abort'], { allowFailure: true });

        // Reset all changes
        await runGit(this.repoPath, ['reset', '--hard', 'HEAD']);

        // Clean untracked files
        await runGit(this.repoPath, ['clean', '-fd']);

        logger.info(`Reset git state to clean for ${operation}`, {
          filesCleared: uncommittedFiles.length,
        });
      } catch (resetErr) {
        logger.error(`Failed to reset git state before ${operation}`, {
          error: resetErr,
        });
        throw new Error(`Cannot proceed with ${operation}: git state is dirty and reset failed`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Main Orchestration Loop
  // ─────────────────────────────────────────────────────────────

  private async runOrchestration(): Promise<void> {
    // Read project direction
    const projectDirection = await this.loadProjectDirection();

    // Determine if we should use hierarchical model
    const clusterCount = this.teamStructure!.clusters.length;
    const useHierarchical = clusterCount > 1;

    logger.info('Starting orchestration', {
      mode: useHierarchical ? 'hierarchical' : 'flat',
      clusters: clusterCount,
    });

    // Calculate max runtime
    const maxRuntimeMs = (this.config.maxRunDurationMinutes || 120) * 60 * 1000;
    const startTime = Date.now();
    let iteration = 0;

    // ─────────────────────────────────────────────────────────────
    // Continuous Loop - runs until time limit or work complete
    // ─────────────────────────────────────────────────────────────
    while (this.state === 'running') {
      iteration++;
      const elapsedMs = Date.now() - startTime;
      const remainingMs = maxRuntimeMs - elapsedMs;

      // Check if we've exceeded max runtime
      if (remainingMs <= 0) {
        logger.info('Max runtime reached, stopping orchestration', {
          maxRuntimeMinutes: this.config.maxRunDurationMinutes,
          iterations: iteration - 1,
        });
        break;
      }

      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`ITERATION ${iteration} STARTING`, {
        elapsedMinutes: Math.floor(elapsedMs / 60000),
        remainingMinutes: Math.floor(remainingMs / 60000),
      });
      logger.info(`${'='.repeat(60)}\n`);

      // Pull latest changes from remote before each iteration
      try {
        const branch = this.workBranch!;
        await runGit(this.repoPath!, ['fetch', 'origin', branch], { allowFailure: true });
        await runGit(this.repoPath!, ['checkout', branch], { allowFailure: true });
        await runGit(this.repoPath!, ['pull', 'origin', branch], { allowFailure: true });
      } catch (pullError) {
        logger.warn('Failed to pull latest changes', { error: pullError });
      }

      try {
        if (useHierarchical) {
          await this.runHierarchicalIteration(projectDirection, iteration);
        } else {
          await this.runFlatIteration(projectDirection, iteration);
        }
      } catch (error: any) {
        logger.error(`Iteration ${iteration} failed`, { error: error.message });

        // Check if this is a rate limit error
        if (this.isRateLimitResult(error.message) || this.isRateLimitResult(error)) {
          logger.warn('Rate limit detected, retrying iteration after auth rotation');
          // Brief pause to allow auth rotation to take effect
          await this.sleep(2000);
          // Retry the same iteration
          iteration--;
          continue;
        }

        // Continue to next iteration unless it's a fatal error
        if (error.message?.includes('No more work')) {
          logger.info('Orchestrator indicated no more work to do');
          break;
        }
      }

      // Brief pause between iterations
      await this.sleep(5000);
    }

    logger.info('Orchestration complete', {
      totalIterations: iteration,
      totalElapsedMinutes: Math.floor((Date.now() - startTime) / 60000),
      stats: this.stats,
    });
  }

  private async loadProjectDirection(): Promise<string> {
    // Use config value if provided
    if (this.config.projectDirection) {
      return this.config.projectDirection;
    }

    // Otherwise try to read from file
    const projectDirPath = join(this.repoPath!, 'PROJECT_DIRECTION.md');
    if (existsSync(projectDirPath)) {
      return await readFile(projectDirPath, 'utf-8');
    }

    throw new Error('No project direction found. Provide via config or PROJECT_DIRECTION.md');
  }

  private async runHierarchicalIteration(
    projectDirection: string,
    iteration: number
  ): Promise<void> {
    const architect = this.teamStructure!.architect;
    const clusters = this.teamStructure!.clusters;
    const clusterCount = clusters.length;

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Architect assigns goals to Tech Leads
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 1: Architect assigning goals to Tech Leads`, {
      clusterCount,
    });

    const architectPrompt = `
# Project Direction

${projectDirection}

# Current Status

This is iteration ${iteration} of continuous development with ${clusterCount} feature clusters.
${iteration > 1 ? 'Previous iterations have already made progress. Focus on REMAINING work.' : 'This is the first iteration.'}

# Your Team Structure

You are the Architect coordinating ${clusterCount} Tech Leads:
${clusters.map((c, i) => `- lead-${i + 1}: managing ${c.workers.length} workers on ${c.featureBranch}`).join('\n')}

# Your Task

Create a JSON plan assigning high-level goals to each Tech Lead.

IMPORTANT:
- Each Tech Lead should have an independent feature area
- Feature areas should NOT overlap or have dependencies
- Focus on CODE implementation

Output ONLY valid JSON (no markdown code blocks):
{
  "features": [
    {
      "lead": "lead-1",
      "featureBranch": "feat/cluster-1",
      "goal": "Brief description of the feature goal",
      "files": ["list", "of", "key", "files"],
      "objectives": ["specific objective 1", "specific objective 2"]
    }
  ]
}

If ALL work is truly complete, output:
{"status": "complete", "reason": "Explanation"}

Read the project direction and codebase, then output the JSON plan.
`;

    let architectJson = '';
    let result = null;
    for await (const message of this.sessionManager.executeTask(
      architect.id,
      architectPrompt,
      {
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        model: this.config.model,
      }
    )) {
      this.handleMessage(architect.id, message);
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            architectJson += block.text;
          }
        }
      }
      if (message.type === 'result') {
        result = (message as any).result || '';
      }
      if (this.state === 'stopped') return;
    }

    // Check for rate limit error in result
    if (result && this.isRateLimitResult(result)) {
      throw new Error(`Rate limit detected: ${result}`);
    }

    // Parse Architect's plan
    type FeatureGoal = { lead: string; featureBranch: string; goal: string; files: string[]; objectives: string[] };
    let featureGoals: FeatureGoal[] = [];

    try {
      const jsonMatch = architectJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const cleanJson = jsonMatch[0].replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanJson);

        if (parsed.status === 'complete') {
          logger.info('Architect indicates all work is complete', { reason: parsed.reason });
          throw new Error('No more work: ' + (parsed.reason || 'All tasks done'));
        }

        if (parsed.features && Array.isArray(parsed.features)) {
          for (const raw of parsed.features) {
            if (raw && typeof raw === 'object') {
              featureGoals.push({
                lead: raw.lead || 'lead-1',
                featureBranch: raw.featureBranch || 'feat/cluster-1',
                goal: String(raw.goal || raw.area || 'Feature implementation'),
                files: Array.isArray(raw.files) ? raw.files : ['src/'],
                objectives: Array.isArray(raw.objectives) ? raw.objectives : ['Implement feature'],
              });
            }
          }
        }
      }

      logger.info('Architect plan parsed', { featureCount: featureGoals.length });
    } catch (error) {
      logger.error('Failed to parse architect plan', { error, architectJson: architectJson.substring(0, 1000) });
      // Fallback: assign each cluster a section
      for (let i = 0; i < clusters.length; i++) {
        featureGoals.push({
          lead: clusters[i].lead.id,
          featureBranch: clusters[i].featureBranch,
          goal: `Section ${i + 1} from PROJECT_DIRECTION.md`,
          files: ['src/'],
          objectives: ['Read PROJECT_DIRECTION.md', 'Implement section', 'Run tests'],
        });
      }
    }

    // Ensure we have goals for all clusters
    if (featureGoals.length === 0) {
      for (let i = 0; i < clusters.length; i++) {
        featureGoals.push({
          lead: clusters[i].lead.id,
          featureBranch: clusters[i].featureBranch,
          goal: `Section ${i + 1} from PROJECT_DIRECTION.md`,
          files: ['src/'],
          objectives: ['Read PROJECT_DIRECTION.md', 'Implement section', 'Run tests'],
        });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Tech Leads assign work to Workers (parallel)
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 2: Tech Leads creating worker assignments`);

    type Assignment = { worker: string; area: string; files: string[]; tasks: string[]; acceptance: string };
    const clusterWorkerAssignments = new Map<string, Assignment[]>();

    await Promise.all(
      clusters.map(async (cluster) => {
        const goal = featureGoals.find((g) => g.lead === cluster.lead.id) ||
          featureGoals.find((g) => g.featureBranch === cluster.featureBranch) ||
          { lead: cluster.lead.id, featureBranch: cluster.featureBranch, goal: 'Feature implementation', files: ['src/'], objectives: ['Implement'] };

        const workerCount = cluster.workers.length;
        const workersList = cluster.workers.map((w) => w.id).join(', ');

        const leadPrompt = `
# Your Feature Goal

${goal.goal}

# Objectives
${goal.objectives.map((o, i) => `${i + 1}. ${o}`).join('\n')}

# Key Files
${goal.files.map(f => `- ${f}`).join('\n')}

# Your Task

You are ${cluster.lead.id}, managing ${workerCount} Workers on ${cluster.featureBranch}.

Your Workers: ${workersList}

IMPORTANT: You must assign work to EXACTLY these workers: ${workersList}.
Do NOT create assignments for workers outside your team.

Create a JSON work plan with exactly ${workerCount} assignments, one for each worker.

Output ONLY valid JSON (no markdown):
{
  "assignments": [
    {
      "worker": "worker-1",
      "area": "Brief description",
      "files": ["file1", "file2"],
      "tasks": ["task1", "task2"],
      "acceptance": "How to verify"
    }
  ]
}

Read the codebase, then output the JSON plan.
`;

        let leadJson = '';
        let leadResult = null;
        for await (const message of this.sessionManager.executeTask(
          cluster.lead.id,
          leadPrompt,
          { tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], model: this.config.model }
        )) {
          this.handleMessage(cluster.lead.id, message);
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                leadJson += block.text;
              }
            }
          }
          if (message.type === 'result') {
            leadResult = (message as any).result || '';
          }
          if (this.state === 'stopped') return;
        }

        // Check for rate limit error in result
        if (leadResult && this.isRateLimitResult(leadResult)) {
          throw new Error(`Rate limit detected in ${cluster.lead.id}: ${leadResult}`);
        }

        // Parse assignments
        let assignments: Assignment[] = [];

        try {
          const jsonMatch = leadJson.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const cleanJson = jsonMatch[0].replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanJson);

            if (parsed.assignments && Array.isArray(parsed.assignments)) {
              for (const raw of parsed.assignments) {
                if (raw && typeof raw === 'object') {
                  assignments.push({
                    worker: raw.worker || 'worker-1',
                    area: String(raw.area || 'Task'),
                    files: Array.isArray(raw.files) ? raw.files : ['src/'],
                    tasks: Array.isArray(raw.tasks) ? raw.tasks : ['Implement'],
                    acceptance: String(raw.acceptance || 'Tests pass'),
                  });
                }
              }
            }
          }

          logger.info(`${cluster.lead.id} plan parsed`, { assignmentCount: assignments.length });
        } catch (error) {
          logger.error(`Failed to parse ${cluster.lead.id} plan`, { error });
          // Fallback
          for (let i = 0; i < workerCount; i++) {
            const workerNum = clusters.indexOf(cluster) * 5 + i + 1;
            assignments.push({
              worker: `worker-${workerNum}`,
              area: `${goal.goal} - Part ${i + 1}`,
              files: goal.files,
              tasks: goal.objectives,
              acceptance: 'Tests pass',
            });
          }
        }

        // Ensure assignments for all workers
        if (assignments.length === 0) {
          for (let i = 0; i < workerCount; i++) {
            const workerNum = clusters.indexOf(cluster) * 5 + i + 1;
            assignments.push({
              worker: `worker-${workerNum}`,
              area: `${goal.goal} - Part ${i + 1}`,
              files: goal.files,
              tasks: goal.objectives,
              acceptance: 'Tests pass',
            });
          }
        }

        clusterWorkerAssignments.set(cluster.featureBranch, assignments);
      })
    );

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Execute Workers and merge to feature branches
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 3: Executing workers and merging to feature branches`);

    // Run all clusters in parallel (each cluster works on its own feature branch)
    const clusterPromises = clusters.map(async (cluster) => {
      const assignments = clusterWorkerAssignments.get(cluster.featureBranch) || [];
      // Track assignments for retry
      const currentAssignments = new Map(assignments.map((a) => [a.worker, a]));

      logger.info(`Starting cluster ${cluster.featureBranch} with ${assignments.length} workers`);

      // Process this cluster's workers with retry logic for rate limits
      let workerPromises = assignments.map((assignment) => {
        const workerSession = cluster.workers.find((w: Session) => w.id === assignment.worker);
        if (!workerSession) {
          return Promise.resolve({ workerId: assignment.worker, worker: assignment.worker, success: false, error: 'Session not found', rateLimited: undefined });
        }
        return this.executeWorkerAssignmentInCluster(assignment, workerSession, cluster.featureBranch, iteration);
      });

      // Wait for all workers in this cluster to complete (with retries for rate limits)
      let results = await Promise.all(workerPromises);

      // Retry rate-limited workers
      for (let retry = 0; retry < 3; retry++) {
        const rateLimitedWorkers = results.filter((r) => 'rateLimited' in r && r.rateLimited);
        if (rateLimitedWorkers.length === 0) break;

        logger.info(`Retrying ${rateLimitedWorkers.length} rate-limited workers in cluster`, { featureBranch: cluster.featureBranch, retry: retry + 1 });

        const retryPromises = rateLimitedWorkers.map((result) => {
          const assignment = currentAssignments.get(result.workerId);
          const workerSession = cluster.workers.find((w: Session) => w.id === result.workerId);
          if (!assignment || !workerSession) {
            return Promise.resolve({ workerId: result.workerId, worker: result.worker, success: false, error: 'Session not found for retry', rateLimited: undefined });
          }
          return this.executeWorkerAssignmentInCluster(assignment, workerSession, cluster.featureBranch, iteration);
        });

        const retryResults = await Promise.all(retryPromises);

        // Update results with retry outcomes
        for (let i = 0; i < results.length; i++) {
          if ('rateLimited' in results[i] && results[i].rateLimited) {
            const retryIndex = retryResults.findIndex((r) => r.workerId === results[i].workerId);
            if (retryIndex !== -1 && 'rateLimited' in retryResults[retryIndex] && !retryResults[retryIndex].rateLimited) {
              results[i] = retryResults[retryIndex];
            }
          }
        }
      }

      // Merge workers to feature branch (serial within cluster to avoid git conflicts)
      for (const result of results) {
        if (result.success && result.workerId) {
          try {
            // Ensure clean state before checkout/merge
            await this.ensureCleanGitState(`merge ${result.workerId}`);

            // Merge worker branch to feature branch
            await runGit(this.repoPath!, ['fetch', 'origin'], { allowFailure: true });
            await runGit(this.repoPath!, ['checkout', cluster.featureBranch]);

            try {
              await runGit(this.repoPath!, ['merge', `origin/${result.workerId}`, '-m', `Merge ${result.workerId}`]);
              this.stats.merges++;
              logger.info(`Merged ${result.workerId} to ${cluster.featureBranch}`);
            } catch {
              logger.warn(`Merge conflict for ${result.workerId}, auto-resolving`);
              // Auto-resolve with better logging
              const unmergedResult = await runGit(this.repoPath!, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
              const unmergedFiles = (typeof unmergedResult?.stdout === 'string' ? unmergedResult.stdout : '').split('\n').filter(Boolean);

              logger.warn(`Auto-resolving ${unmergedFiles.length} conflicts for ${result.workerId}`, {
                branch: cluster.featureBranch,
                files: unmergedFiles.slice(0, 10), // Log first 10 files
                totalFiles: unmergedFiles.length,
                strategy: 'theirs-first',
              });

              // For each file, try --theirs first, then fall back to --ours
              for (const file of unmergedFiles) {
                try {
                  await runGit(this.repoPath!, ['checkout', '--theirs', file], { allowFailure: true });
                  logger.debug(`Resolved ${file} using --theirs`);
                } catch {
                  await runGit(this.repoPath!, ['checkout', '--ours', file], { allowFailure: true });
                  logger.debug(`Resolved ${file} using --ours (--theirs failed)`);
                }
              }

              await runGit(this.repoPath!, ['add', '.'], { allowFailure: true });
              await runGit(this.repoPath!, ['commit', '-m', `Merge ${result.workerId} (auto-resolved ${unmergedFiles.length} conflicts)`], { allowFailure: true });
              this.stats.conflicts++;
              this.stats.conflicts += unmergedFiles.length;
            }

            // Push feature branch
            await runGit(this.repoPath!, ['push', 'origin', cluster.featureBranch], { allowFailure: true });
          } catch (mergeErr) {
            logger.error(`Failed to merge ${result.workerId} to ${cluster.featureBranch}`, { error: mergeErr });
          }
        } else if ('rateLimited' in result && result.rateLimited) {
          logger.warn(`Worker ${result.workerId} still rate-limited after retries in cluster ${cluster.featureBranch}`);
        } else {
          logger.error(`Worker ${result.workerId} failed in cluster ${cluster.featureBranch}`, { error: result.error });
        }
      }

      logger.info(`Cluster ${cluster.featureBranch} completed with ${assignments.length} workers`);

      return {
        featureBranch: cluster.featureBranch,
        completed: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success && !('rateLimited' in r && r.rateLimited)).length,
        results,
      };
    });

    // Wait for all clusters to complete in parallel
    const clusterResults = await Promise.all(clusterPromises);

    // Log summary of all clusters
    logger.info(`All clusters completed`, {
      totalClusters: clusters.length,
      clustersCompleted: clusterResults.filter((c) => c.completed > 0).length,
      totalWorkers: clusterResults.reduce((sum, c) => sum + c.results.length, 0),
      workersCompleted: clusterResults.reduce((sum, c) => sum + c.completed, 0),
      workersFailed: clusterResults.reduce((sum, c) => sum + c.failed, 0),
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Merge feature branches to main (if ready)
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 4: Merging feature branches to main`);

    for (const cluster of clusters) {
      try {
        // Ensure clean state before checkout/merge
        await this.ensureCleanGitState(`merge ${cluster.featureBranch} to main`);

        await runGit(this.repoPath!, ['fetch', 'origin'], { allowFailure: true });
        await runGit(this.repoPath!, ['checkout', this.workBranch!]);

        try {
          await runGit(this.repoPath!, ['merge', `origin/${cluster.featureBranch}`, '-m', `Merge ${cluster.featureBranch}`]);
          this.stats.merges++;
          logger.info(`Merged ${cluster.featureBranch} to main`);
        } catch {
          logger.warn(`Merge conflict for ${cluster.featureBranch}, auto-resolving`);
          // Auto-resolve with better logging
          const unmergedResult = await runGit(this.repoPath!, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true });
          const unmergedFiles = (typeof unmergedResult?.stdout === 'string' ? unmergedResult.stdout : '').split('\n').filter(Boolean);

          logger.warn(`Auto-resolving ${unmergedFiles.length} conflicts for ${cluster.featureBranch}`, {
            files: unmergedFiles.slice(0, 10),
            totalFiles: unmergedFiles.length,
            strategy: 'theirs-first',
          });

          for (const file of unmergedFiles) {
            try {
              await runGit(this.repoPath!, ['checkout', '--theirs', file], { allowFailure: true });
              logger.debug(`Resolved ${file} using --theirs`);
            } catch {
              await runGit(this.repoPath!, ['checkout', '--ours', file], { allowFailure: true });
              logger.debug(`Resolved ${file} using --ours (--theirs failed)`);
            }
          }
          await runGit(this.repoPath!, ['add', '.'], { allowFailure: true });
          await runGit(this.repoPath!, ['commit', '-m', `Merge ${cluster.featureBranch} (auto-resolved ${unmergedFiles.length} conflicts)`], { allowFailure: true });
          this.stats.conflicts++;
          this.stats.conflicts += unmergedFiles.length;
        }

        // Push main branch
        await runGit(this.repoPath!, ['push', 'origin', this.workBranch!], { allowFailure: true });
      } catch (mergeErr) {
        logger.error(`Failed to merge ${cluster.featureBranch} to main`, { error: mergeErr });
      }
    }

    logger.info(`[Iteration ${iteration}] Hierarchical iteration complete`, {
      clustersProcessed: clusters.length,
      stats: this.stats,
    });
  }

  private async runFlatIteration(
    projectDirection: string,
    iteration: number
  ): Promise<void> {
    // Get architect and all workers from all clusters
    const architect = this.teamStructure!.architect;
    const allWorkers = this.teamStructure!.clusters.flatMap((c: TeamCluster) => c.workers);
    const workerCount = allWorkers.length;

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Architect creates work plan
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 1: Architect creating work plan`, { workerCount });

    const planPrompt = `
# Project Direction

${projectDirection}

# Current Status

This is iteration ${iteration} of continuous development.
${iteration > 1 ? 'Previous iterations have already made progress. Focus on REMAINING work that has not been completed yet.' : 'This is the first iteration.'}

# Your Task

Create a JSON work plan for ${workerCount} Workers (worker-1 through worker-${workerCount}).
Each Worker will work IN PARALLEL on their assigned area.

IMPORTANT:
- Read the codebase to understand what work remains
- Check test results, build status, or other project-specific verification methods
- Only report complete when ALL documented tasks are verifiably done
- If there are still failing tests or incomplete features, assign that work

Output ONLY valid JSON (no markdown code blocks):
{"assignments": [{"worker": "worker-1", "area": "...", "files": [...], "tasks": [...], "acceptance": "..."}]}

If ALL work is truly complete (verified via tests/builds), output:
{"status": "complete", "reason": "Explanation of how completion was verified"}

Read the project direction and codebase, then output the JSON plan.
`;

    let planJson = '';
    let planResult = null;
    for await (const message of this.sessionManager.executeTask(
      architect.id,
      planPrompt,
      {
        // Architect uses read-only tools (prevents git index locks)
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        model: this.config.model,
      }
    )) {
      this.handleMessage(architect.id, message);

      // Capture text output for JSON parsing
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            planJson += block.text;
          }
        }
      }

      if (message.type === 'result') {
        planResult = (message as any).result || '';
      }

      if (this.state === 'stopped') return;
    }

    // Check for rate limit error in result
    if (planResult && this.isRateLimitResult(planResult)) {
      throw new Error(`Rate limit detected: ${planResult}`);
    }

    // Parse the architect's plan
    type Assignment = { worker: string; area: string; files: string[]; tasks: string[]; acceptance: string };
    let assignments: Assignment[] = [];

    try {
      // Extract JSON from the text
      let cleanJson = '';

      // Approach 1: Try to extract from markdown code blocks first
      const codeBlockMatch = planJson.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        cleanJson = codeBlockMatch[1].trim();
      }

      // Approach 2: If no code block, try to find bare JSON object
      if (!cleanJson) {
        const jsonMatch = planJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanJson = jsonMatch[0];
        }
      }

      if (!cleanJson) {
        throw new Error('No JSON object found in architect output');
      }

      // Final cleanup
      cleanJson = cleanJson.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();

      const parsed = JSON.parse(cleanJson);

      // Check if architect says work is complete
      if (parsed.status === 'complete') {
        logger.info('Architect indicates all work is complete', { reason: parsed.reason });
        throw new Error('No more work: ' + (parsed.reason || 'All tasks done'));
      }

      // Handle different JSON structures
      if (parsed.assignments && Array.isArray(parsed.assignments)) {
        for (let i = 0; i < parsed.assignments.length; i++) {
          const raw = parsed.assignments[i];
          if (!raw || typeof raw !== 'object') continue;

          assignments.push({
            worker: raw.worker || `worker-${i + 1}`,
            area: String(raw.area || raw.title || raw.description || `Area ${i + 1}`),
            files: Array.isArray(raw.files) ? raw.files : ['src/'],
            tasks: Array.isArray(raw.tasks) ? raw.tasks : ['Implement assigned features'],
            acceptance: String(raw.acceptance || 'Tests pass'),
          });
        }
      }

      logger.info('Architect plan parsed', { assignmentCount: assignments.length });
    } catch (error) {
      logger.error('Failed to parse architect plan', { error, planJson: planJson.substring(0, 1000) });
      // Fallback: create default assignments for each worker
      logger.warn('Using fallback plan assignments');
      for (let i = 1; i <= workerCount; i++) {
        assignments.push({
          worker: `worker-${i}`,
          area: `Section ${i} from PROJECT_DIRECTION.md`,
          files: ['src/'],
          tasks: ['Read PROJECT_DIRECTION.md', 'Implement assigned section', 'Run tests'],
          acceptance: 'Tests pass and code compiles',
        });
      }
    }

    // Ensure we have assignments for all workers
    if (assignments.length === 0) {
      logger.warn('No valid assignments from architect, using fallback');
      for (let i = 1; i <= workerCount; i++) {
        assignments.push({
          worker: `worker-${i}`,
          area: `Section ${i} from PROJECT_DIRECTION.md`,
          files: ['src/'],
          tasks: ['Read PROJECT_DIRECTION.md', 'Implement assigned section', 'Run tests'],
          acceptance: 'Tests pass and code compiles',
        });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Execute Workers in parallel
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 2: Spawning Workers in parallel`, {
      workerCount: assignments.length,
      assignments: assignments.map(a => ({ worker: a.worker, area: a.area }))
    });

    const workerPromises = assignments.map((assignment) => {
      const workerSession = allWorkers.find((w: Session) => w.id === assignment.worker);
      if (!workerSession) {
        logger.warn('Worker session not found', { worker: assignment.worker });
        return Promise.resolve({ worker: assignment.worker, success: false, error: 'Session not found', result: undefined, rateLimited: undefined });
      }
      return this.executeWorkerAssignment(assignment, workerSession, iteration);
    });

    // ─────────────────────────────────────────────────────────────
    // Continuous merge: As each Worker completes, merge and reassign
    // ─────────────────────────────────────────────────────────────
    const pendingPromises = new Map(workerPromises.map((p, i) => [assignments[i].worker, p]));
    // Track current assignments for retry (especially for rate-limited workers)
    const currentAssignments = new Map(assignments.map((a) => [a.worker, a]));
    const completedWorkers: string[] = [];
    let reassignmentRound = 0;

    while (pendingPromises.size > 0 && this.state !== 'stopped') {
      // Wait for any Worker to complete
      const raceResult = await Promise.race(
        Array.from(pendingPromises.entries()).map(async ([workerId, promise]) => {
          const result = await promise;
          return { workerId, result };
        })
      );

      const { workerId, result } = raceResult;
      pendingPromises.delete(workerId);
      completedWorkers.push(workerId);

      if (result.success) {
        // Immediately merge this Worker's branch
        logger.info(`Worker completed, merging: ${workerId}`, { resultLength: result.result?.length });
        try {
          // Ensure clean state before checkout/merge
          await this.ensureCleanGitState(`merge ${workerId}`);

          const branch = this.workBranch!;
          // Fetch all remotes to update remote tracking branches (needed for origin/workerId)
          await runGit(this.repoPath!, ['fetch', 'origin'], { allowFailure: true });
          // Explicitly fetch the worker branch to ensure it's available locally
          await runGit(this.repoPath!, ['fetch', 'origin', `${workerId}:${workerId}`], { allowFailure: true });
          await runGit(this.repoPath!, ['checkout', branch]);
          try {
            // Merge using the local ref (not origin/workerId)
            await runGit(this.repoPath!, ['merge', workerId, '-m', `Merge ${workerId} branch`]);
            this.stats.merges++;
            logger.info(`Merged: ${workerId}`);
          } catch {
            logger.warn(`Merge conflict for ${workerId}, auto-resolving`);
            // Accept theirs for content conflicts with better logging
            const unmergedResult = await runGit(
              this.repoPath!,
              ['diff', '--name-only', '--diff-filter=U'],
              { allowFailure: true }
            );
            const unmergedFiles = (typeof unmergedResult?.stdout === 'string' ? unmergedResult.stdout : '').split('\n').filter(Boolean);

            logger.warn(`Auto-resolving ${unmergedFiles.length} conflicts for ${workerId}`, {
              files: unmergedFiles.slice(0, 10), // Log first 10 files
              totalFiles: unmergedFiles.length,
              strategy: 'theirs-first',
            });

            for (const file of unmergedFiles) {
              try {
                await runGit(this.repoPath!, ['checkout', '--theirs', file], { allowFailure: true });
                logger.debug(`Resolved ${file} using --theirs`);
              } catch {
                await runGit(this.repoPath!, ['checkout', '--ours', file], { allowFailure: true });
                logger.debug(`Resolved ${file} using --ours (--theirs failed)`);
              }
            }
            await runGit(this.repoPath!, ['add', '.'], { allowFailure: true });
            await runGit(this.repoPath!, ['commit', '-m', `Merge ${workerId} (auto-resolved ${unmergedFiles.length} conflicts)`], { allowFailure: true });
            this.stats.conflicts++;
            this.stats.conflicts += unmergedFiles.length;
          }
          // Push after each merge
          await runGit(this.repoPath!, ['push', 'origin', branch], { allowFailure: true });
        } catch (mergeErr) {
          logger.error(`Failed to merge ${workerId}`, { error: mergeErr });
        }

        // Ask Lead for new work for this Worker
        await runGit(this.repoPath!, ['pull', 'origin', this.workBranch!, '--rebase'], { allowFailure: true });

        reassignmentRound++;
        const newWorkPrompt = `
Worker ${workerId} has completed their work and merged to ${this.workBranch}.

Current status:
- ${completedWorkers.length} Workers have completed at least one task
- ${pendingPromises.size} Workers still working on their current task
- Total reassignments so far: ${reassignmentRound}

Review PROJECT_DIRECTION.md and the current codebase state (git pull was done).
Check what work remains - run tests, check conformance, etc.

If there is MORE work to do, output a new assignment for ${workerId}:
{"worker": "${workerId}", "area": "...", "files": [...], "tasks": [...], "acceptance": "..."}

If ALL work is truly complete (verified), output:
{"status": "complete", "reason": "Explanation"}

Output ONLY valid JSON (no markdown).
`;

        // Get new assignment from Architect
        logger.info(`Requesting new work for ${workerId}`, { reassignmentRound });
        let newAssignmentJson = '';
        try {
          for await (const message of this.sessionManager.executeTask(
            architect.id,
            newWorkPrompt,
            { tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], model: this.config.model }
          )) {
            if (message.type === 'assistant' && message.message?.content) {
              for (const block of message.message.content) {
                if (block.type === 'text') newAssignmentJson += block.text;
              }
            }
          }

          // Parse the response
          const jsonMatch = newAssignmentJson.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.status === 'complete') {
              logger.info(`Architect says work complete for ${workerId}`, { reason: parsed.reason });
              // Don't add back to pending - this Worker is done
            } else if (parsed.worker && parsed.area) {
              // Valid new assignment - start Worker on new work
              logger.info(`New assignment for ${workerId}`, { area: parsed.area });
              const workerSession = allWorkers.find((w: Session) => w.id === workerId);
              if (workerSession) {
                const newPromise = this.executeWorkerAssignment(parsed, workerSession, iteration);
                pendingPromises.set(workerId, newPromise);
              }
            }
          }
        } catch (reassignError) {
          logger.warn(`Failed to get reassignment for ${workerId}`, { error: reassignError });
        }
      } else if ('rateLimited' in result && result.rateLimited) {
        // Worker was rate-limited - retry with same assignment using new API key
        const currentAssignment = currentAssignments.get(workerId);
        if (currentAssignment) {
          logger.info(`Retrying rate-limited worker with new API key: ${workerId}`, { area: currentAssignment.area });
          const workerSession = allWorkers.find((w: Session) => w.id === workerId);
          if (workerSession) {
            const retryPromise = this.executeWorkerAssignment(currentAssignment, workerSession, iteration);
            pendingPromises.set(workerId, retryPromise);
            // Remove from completed so we wait for retry
            completedWorkers.pop();
          }
        }
      } else {
        logger.error(`Worker failed: ${workerId}`, { error: result.error });
      }
    }

    logger.info('All Workers completed', {
      completed: completedWorkers.length,
    });

    // Final sync - ensure work branch is pushed
    const branch = this.workBranch!;
    try {
      await runGit(this.repoPath!, ['checkout', branch]);
      await runGit(this.repoPath!, ['fetch', 'origin', branch], { allowFailure: true });
      await runGit(this.repoPath!, ['rebase', `origin/${branch}`], { allowFailure: true });
      await runGit(this.repoPath!, ['push', 'origin', branch]);
      logger.info(`[Iteration ${iteration}] Final push to origin complete`, { branch });
    } catch (error) {
      logger.error(`[Iteration ${iteration}] Final push failed`, { error, branch });
    }

    logger.info(`[Iteration ${iteration}] Complete`, {
      completed: completedWorkers.length,
      stats: this.stats,
    });
  }

  /**
   * Execute a Worker assignment in a cluster (for hierarchical model)
   */
  private async executeWorkerAssignmentInCluster(
    assignment: { worker: string; area: string; files: string[]; tasks: string[]; acceptance: string },
    workerSession: Session,
    featureBranch: string,
    iteration: number
  ): Promise<{ worker: string; success: boolean; result?: string; error?: string; workerId: string; rateLimited?: boolean }> {
    const workerPrompt = `
# Your Assignment: ${assignment.area}

You are ${assignment.worker}, a skilled software engineer.

## Files to Focus On
${assignment.files.map(f => `- ${f}`).join('\n')}

## Tasks
${assignment.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Acceptance Criteria
${assignment.acceptance}

## CRITICAL RULES
- IMPLEMENT CODE - do not create documentation
- Edit source files (.rs, .ts, .js, etc.)
- Write tests when appropriate
- Commit with clear messages
- Push your branch (${assignment.worker}) when done

## Git Workflow
- Work on your branch (${assignment.worker})
- Make atomic commits as you complete changes
- Push when done

**START IMPLEMENTING NOW.**
`;

    logger.info(`Starting Worker: ${assignment.worker}`, { area: assignment.area, iteration, featureBranch });

    // ─────────────────────────────────────────────────────────────
    // ANTI-DRIFT: Proactive Sync (Start)
    // ─────────────────────────────────────────────────────────────
    // Ensure worker is up to date with the feature branch before starting.
    // This prevents them from writing code based on a stale version.
    if (workerSession?.worktreePath) {
      try {
        // Fetch the latest feature branch
        await runGit(workerSession.worktreePath, ['fetch', 'origin', featureBranch], { allowFailure: true });
        // Reset hard to match remote feature branch start point to avoid history divergence
        // Only do this if we don't have local unpushed commits we care about (which we shouldn't at start of task)
        await runGit(workerSession.worktreePath, ['reset', '--hard', `origin/${featureBranch}`], { allowFailure: true });
        logger.debug(`Synced ${assignment.worker} worktree to ${featureBranch}`);
      } catch (err) {
        logger.warn(`Failed to sync worker start state: ${assignment.worker}`, { error: err });
      }
    }

    try {
      let result = '';
      // Capture the generator to get the final return value
      const generator = this.sessionManager.executeTask(
        workerSession.id,
        workerPrompt,
        {
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          model: this.config.model,
        }
      );

      // Process messages from the generator
      for await (const message of generator) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown>;
              let details = '';
              if (block.name === 'Read' || block.name === 'Write' || block.name === 'Edit') {
                details = String(input?.file_path || input?.path || '').split('/').slice(-2).join('/');
              } else if (block.name === 'Bash') {
                details = String(input?.command || '').slice(0, 60);
              } else if (block.name === 'Grep' || block.name === 'Glob') {
                details = String(input?.pattern || '').slice(0, 40);
              }
              logger.info('Tool call', { sessionId: assignment.worker, tool: block.name, details: details || undefined });
            }
            if (block.type === 'text') {
              result += block.text;
            }
          }
        }

        if (this.state === 'stopped') {
          return { workerId: assignment.worker, worker: assignment.worker, success: false, error: 'Orchestrator stopped', rateLimited: undefined };
        }
      }

      // Get the final return value from the generator (includes rateLimited status)
      const finalResult = await generator.next();
      const taskResult = finalResult.value as TaskResult;

      // If rate limited, return without marking as failed so it can be retried
      if (taskResult?.rateLimited) {
        logger.warn(`Worker rate-limited, will retry with new API key: ${assignment.worker}`);
        return { workerId: assignment.worker, worker: assignment.worker, success: false, error: taskResult.error || 'Rate limited', rateLimited: true };
      }

      // If task failed (not rate limited), return error
      if (taskResult && !taskResult.success) {
        logger.error(`Worker task failed: ${assignment.worker}`, { error: taskResult.error });
        return { workerId: assignment.worker, worker: assignment.worker, success: false, error: taskResult.error };
      }

      // Ensure worker branch is pushed to origin
      if (workerSession?.worktreePath) {
        try {
          await runGit(workerSession.worktreePath, ['add', '.'], { allowFailure: true });
          await runGit(workerSession.worktreePath, ['commit', '-m', `Worker ${assignment.worker}: ${assignment.area}`], { allowFailure: true });
          // Push WITHOUT allowFailure to see actual errors
          await runGit(workerSession.worktreePath, ['push', '-u', 'origin', assignment.worker]);
          logger.info(`Pushed worker branch: ${assignment.worker}`);
        } catch (pushErr) {
          logger.warn(`Failed to push worker branch: ${assignment.worker}`, { error: pushErr });
        }
      }

      logger.info(`Worker completed: ${assignment.worker}`, { resultLength: result.length });
      return { workerId: assignment.worker, worker: assignment.worker, success: true, result };
    } catch (error: any) {
      const errorMessage = error?.message || error?.shortMessage || String(error);
      logger.error(`Worker failed: ${assignment.worker}`, { error: errorMessage });
      return { workerId: assignment.worker, worker: assignment.worker, success: false, error: errorMessage };
    }
  }

  /**
   * Execute a Worker assignment
   */
  private async executeWorkerAssignment(
    assignment: { worker: string; area: string; files: string[]; tasks: string[]; acceptance: string },
    workerSession: Session,
    iteration: number
  ): Promise<{ worker: string; success: boolean; result?: string; error?: string; rateLimited?: boolean }> {
    const workerPrompt = `
# Your Assignment: ${assignment.area}

You are ${assignment.worker}, a skilled software engineer.

## Files to Focus On
${assignment.files.map(f => `- ${f}`).join('\n')}

## Tasks
${assignment.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Acceptance Criteria
${assignment.acceptance}

## CRITICAL RULES
- IMPLEMENT CODE - do not create documentation
- Edit source files (.rs, .ts, .js, etc.)
- Write tests when appropriate
- Commit with clear messages
- Push your branch (${assignment.worker}) when done

## Git Workflow
- Work on your branch (${assignment.worker})
- Make atomic commits as you complete changes
- Push when done

**START IMPLEMENTING NOW.**
`;

    logger.info(`Starting Worker: ${assignment.worker}`, { area: assignment.area, iteration });

    const targetBranch = this.workBranch!; // In flat mode, we target the main run branch

    // ─────────────────────────────────────────────────────────────
    // ANTI-DRIFT: Proactive Sync (Start)
    // ─────────────────────────────────────────────────────────────
    // Ensure worker is up to date with the target branch before starting.
    // This prevents them from writing code based on a stale version.
    if (workerSession?.worktreePath) {
      try {
        // Fetch the latest target branch
        await runGit(workerSession.worktreePath, ['fetch', 'origin', targetBranch], { allowFailure: true });
        // Reset hard to match remote target branch start point to avoid history divergence
        await runGit(workerSession.worktreePath, ['reset', '--hard', `origin/${targetBranch}`], { allowFailure: true });
        logger.debug(`Synced ${assignment.worker} worktree to ${targetBranch}`);
      } catch (err) {
        logger.warn(`Failed to sync worker start state: ${assignment.worker}`, { error: err });
      }
    }

    try {
      let result = '';
      // Capture the generator to get the final return value
      const generator = this.sessionManager.executeTask(
        workerSession.id,
        workerPrompt,
        {
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          model: this.config.model,
        }
      );

      // Process messages from the generator
      for await (const message of generator) {
        // Log Worker tool calls
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown>;
              let details = '';
              if (block.name === 'Read' || block.name === 'Write' || block.name === 'Edit') {
                details = String(input?.file_path || input?.path || '').split('/').slice(-2).join('/');
              } else if (block.name === 'Bash') {
                details = String(input?.command || '').slice(0, 60);
              } else if (block.name === 'Grep' || block.name === 'Glob') {
                details = String(input?.pattern || '').slice(0, 40);
              }
              logger.info('Tool call', { sessionId: assignment.worker, tool: block.name, details: details || undefined });
              this.emitEvent('tool:start', { sessionId: assignment.worker, tool: block.name, input: block.input });
            }
            if (block.type === 'text') {
              result += block.text;
            }
          }
        }

        if (this.state === 'stopped') {
          return { worker: assignment.worker, success: false, error: 'Orchestrator stopped', rateLimited: undefined };
        }
      }

      // Get the final return value from the generator (includes rateLimited status)
      const finalResult = await generator.next();
      const taskResult = finalResult.value as TaskResult;

      // If rate limited, return without marking as failed so it can be retried
      if (taskResult?.rateLimited) {
        logger.warn(`Worker rate-limited, will retry with new API key: ${assignment.worker}`);
        return { worker: assignment.worker, success: false, error: taskResult.error || 'Rate limited', rateLimited: true };
      }

      // If task failed (not rate limited), return error
      if (taskResult && !taskResult.success) {
        logger.error(`Worker task failed: ${assignment.worker}`, { error: taskResult.error });
        return { worker: assignment.worker, success: false, error: taskResult.error };
      }

      // Ensure worker branch is pushed to origin
      if (workerSession?.worktreePath) {
        try {
          await runGit(workerSession.worktreePath, ['add', '.'], { allowFailure: true });
          await runGit(workerSession.worktreePath, ['commit', '-m', `Worker ${assignment.worker}: ${assignment.area}`], { allowFailure: true });
          // Push WITHOUT allowFailure to see actual errors
          await runGit(workerSession.worktreePath, ['push', '-u', 'origin', assignment.worker]);
          logger.info(`Pushed worker branch: ${assignment.worker}`);
        } catch (pushErr) {
          logger.warn(`Failed to push worker branch: ${assignment.worker}`, { error: pushErr });
        }
      }

      logger.info(`Worker completed: ${assignment.worker}`, { resultLength: result.length });
      return { worker: assignment.worker, success: true, result };
    } catch (error: any) {
      const errorMessage = error?.message || error?.shortMessage || String(error);
      logger.error(`Worker failed: ${assignment.worker}`, { error: errorMessage });
      return { worker: assignment.worker, success: false, error: errorMessage };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────

  private handleMessage(sessionId: string, message: any): void {
    // Log important message types
    if (message.type === 'system' && message.subtype === 'init') {
      logger.debug('Session initialized', {
        sessionId,
        claudeSessionId: message.session_id,
      });
    }

    if ('result' in message) {
      logger.info('Task completed', {
        sessionId,
        resultLength: message.result?.length || 0,
      });
    }

    // Log all tool calls with details
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown>;
          let details = '';
          if (block.name === 'Read' || block.name === 'Write' || block.name === 'Edit') {
            details = String(input?.file_path || input?.path || '').split('/').slice(-2).join('/');
          } else if (block.name === 'Bash') {
            details = String(input?.command || '').slice(0, 80);
          } else if (block.name === 'Grep' || block.name === 'Glob') {
            details = String(input?.pattern || '').slice(0, 50);
          } else if (block.name === 'Task') {
            details = `subagent=${input?.subagent_type}, prompt=${String(input?.prompt || '').slice(0, 50)}...`;
          }
          logger.info('Tool call', { sessionId, tool: block.name, details: details || undefined });
        }

        // Check for git operations
        if (block.type === 'tool_use' && block.name === 'Bash') {
          const command = (block.input as any)?.command || '';
          if (command.includes('git commit')) {
            this.stats.commits++;
          }
          if (command.includes('git merge')) {
            this.stats.merges++;
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────

  private emitEvent(type: OrchestratorEvent['type'], data: Record<string, unknown>): void {
    const event: OrchestratorEvent = {
      type,
      timestamp: new Date(),
      data,
    };
    this.emit(type, event);
    this.emit('event', event);
  }

  private forwardSessionEvents(): void {
    const events = [
      'session:created',
      'session:resumed',
      'session:forked',
      'session:expired',
      'session:compacted',
      'task:start',
      'task:complete',
      'task:error',
      'tool:start',
      'tool:complete',
      'file:modified',
      'text:stream',
      'query:start',
      'query:message',
    ];

    for (const event of events) {
      this.sessionManager.on(event, (data) => {
        this.emitEvent(event as OrchestratorEvent['type'], data);
      });
    }

    // Handle session compaction for long-running sessions
    this.sessionManager.on('session:needs-compaction', async (data: { sessionId: string }) => {
      logger.info('Session needs compaction, triggering...', { sessionId: data.sessionId });
      try {
        await this.sessionManager.compactSession(data.sessionId);
        logger.info('Session compacted successfully', { sessionId: data.sessionId });
      } catch (error) {
        logger.error('Failed to compact session', { sessionId: data.sessionId, error });
      }
    });
  }

  private isRateLimitResult(result: string): boolean {
    const message = String(result);
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('quota exceeded') ||
      message.includes('too many requests') ||
      message.includes('hit your limit') ||
      message.includes("hit's your limit")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────

/**
 * Create an orchestrator from a config file
 */
export async function createOrchestratorFromConfig(
  configPath: string,
  workspaceDir: string
): Promise<Orchestrator> {
  const content = await readFile(configPath, 'utf-8');
  const config = JSON.parse(content);

  const orchConfig: Partial<OrchestratorConfig> & Pick<OrchestratorConfig, 'repositoryUrl' | 'branch' | 'workspaceDir' | 'projectDirection'> = {
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    workspaceDir,
    localRepoPath: config.localRepoPath,
    projectDirection: '', // Will be loaded from PROJECT_DIRECTION.md
    workerCount: config.workerCount || 2,
    model: config.model || 'opus',
    authMode: config.authMode || 'oauth',
    taskTimeoutMs: config.taskTimeoutMs || 600000,
    pollIntervalMs: config.pollIntervalMs || 5000,
    maxRunDurationMinutes: config.maxRunDurationMinutes || 120,
  };

  return new Orchestrator(orchConfig);
}
