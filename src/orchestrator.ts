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
import { mkdir, readFile } from 'fs/promises';
import { SessionManager, type SessionManagerConfig } from './session-manager.js';
import {
  createLeadAgent,
  createWorkerAgent,
  createWorkerAgents,
  type AgentDefinition,
} from './agents.js';
import { createDefaultHooks, gitLock, type HooksConfig } from './hooks.js';
import type {
  OrchestratorConfig,
  OrchestratorStatus,
  OrchestratorState,
  OrchestratorEvent,
  Session,
  TeamStructure,
  AuthConfig,
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
  maxRunDurationMinutes: 120,
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

    const leadSession = this.teamStructure.lead;

    if (!leadSession) {
      throw new Error('No lead session found');
    }

    logger.info('Continuing orchestration with new prompt', {
      sessionId: leadSession.id,
      promptLength: prompt.length,
    });

    // Create worker agents for delegation
    const agents = createWorkerAgents(this.config.workerCount);

    // Execute continuation on the lead session
    for await (const message of this.sessionManager.executeTask(
      leadSession.id,
      prompt,
      {
        allowedTools: ['Read', 'Glob', 'Grep', 'Task'],
        agents,
        model: this.config.model,
      }
    )) {
      this.handleMessage(leadSession.id, message);
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
      await this.runGit(['fetch', 'origin'], this.repoPath);
      await this.runGit(['checkout', branch], this.repoPath);
      await this.runGit(['pull', 'origin', branch], this.repoPath);
    } else if (localRepoPath) {
      // Copy from local path (faster than cloning)
      logger.info('Copying repository from local path', { localRepoPath, branch });
      const { execa } = await import('execa');

      // Create the target directory
      await mkdir(this.repoPath, { recursive: true });

      // Use rsync to copy
      await execa('rsync', [
        '-aH',
        '--exclude', '.orchestrator',
        '--exclude', 'node_modules',
        `${localRepoPath}/`,
        `${this.repoPath}/`,
      ]);

      // Checkout the desired branch
      await this.runGit(['checkout', branch], this.repoPath);
      await this.runGit(['pull', 'origin', branch], this.repoPath, { ignoreError: true });
    } else {
      // Clone
      logger.info('Cloning repository', { repositoryUrl, branch });
      await mkdir(this.repoPath, { recursive: true });

      // Build clone arguments
      const cloneArgs = ['clone', '--branch', branch];
      const cloneOpts = this.config.gitCloneOptions;
      if (cloneOpts?.depth) {
        cloneArgs.push('--depth', String(cloneOpts.depth));
      }
      if (cloneOpts?.singleBranch) {
        cloneArgs.push('--single-branch');
      }
      if (cloneOpts?.noSubmodules) {
        cloneArgs.push('--no-recurse-submodules');
      }
      cloneArgs.push(repositoryUrl, '.');

      await this.runGit(cloneArgs, this.repoPath);
    }

    // Set up the work branch (either same as source branch, or a new run branch)
    if (this.config.useRunBranch) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.workBranch = `run-${timestamp}`;

      await this.runGit(['checkout', '-b', this.workBranch], this.repoPath);
      await this.runGit(['push', '-u', 'origin', this.workBranch], this.repoPath);

      logger.info('Created run branch', { workBranch: this.workBranch, sourceBranch: branch });
    } else {
      this.workBranch = branch;
    }

    logger.info('Repository setup complete', { repoPath: this.repoPath, workBranch: this.workBranch });
  }

  private async createTeamStructure(): Promise<void> {
    logger.info('Creating team structure', {
      workerCount: this.config.workerCount,
    });

    // Create Lead session (runs in main repo with read-only tools)
    let lead = this.sessionManager.getSession('lead');
    if (!lead) {
      lead = await this.sessionManager.createSession(
        'lead',
        'lead',
        this.repoPath,
        this.workBranch!
      );
    }

    // Create Worker sessions (each has own worktree)
    const workers: Session[] = [];
    for (let i = 1; i <= this.config.workerCount; i++) {
      const workerId = `worker-${i}`;
      let worker = this.sessionManager.getSession(workerId);
      if (!worker) {
        const workerPath = await this.createWorktree(workerId);
        worker = await this.sessionManager.createSession(
          workerId,
          'worker',
          workerPath,
          workerId
        );
      }
      workers.push(worker);
    }

    this.teamStructure = {
      lead,
      workers,
    };

    logger.info('Team structure created', {
      lead: lead.id,
      workers: workers.map(w => w.id),
    });
  }

  private async createWorktree(name: string): Promise<string> {
    // Use absolute path to avoid git interpreting it relative to repo directory
    const worktreePath = resolve(join(this.config.workspaceDir, 'worktrees', name));

    if (existsSync(worktreePath)) {
      // Worktree exists, just return the path
      return worktreePath;
    }

    // Create branch and worktree
    await gitLock.acquire();
    try {
      // Create or checkout branch
      await this.runGit(
        ['branch', name],
        this.repoPath!,
        { ignoreError: true }
      );

      // Create worktree
      await this.runGit(
        ['worktree', 'add', worktreePath, name],
        this.repoPath!
      );

      logger.info('Created worktree', { name, path: worktreePath });
    } finally {
      gitLock.release();
    }

    return worktreePath;
  }

  // ─────────────────────────────────────────────────────────────
  // Main Orchestration Loop
  // ─────────────────────────────────────────────────────────────

  private async runOrchestration(): Promise<void> {
    // Read project direction
    const projectDirection = await this.loadProjectDirection();

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
        await this.runGit(['fetch', 'origin', branch], this.repoPath!, { ignoreError: true });
        await this.runGit(['checkout', branch], this.repoPath!, { ignoreError: true });
        await this.runGit(['pull', 'origin', branch], this.repoPath!, { ignoreError: true });
      } catch (pullError) {
        logger.warn('Failed to pull latest changes', { error: pullError });
      }

      try {
        await this.runSingleIteration(projectDirection, iteration);
      } catch (error: any) {
        logger.error(`Iteration ${iteration} failed`, { error: error.message });
        // Continue to next iteration unless it's a fatal error
        if (error.message?.includes('No more work')) {
          logger.info('Lead indicated no more work to do');
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

  private async runSingleIteration(
    projectDirection: string,
    iteration: number
  ): Promise<void> {
    const lead = this.teamStructure!.lead;
    const workers = this.teamStructure!.workers;
    const workerCount = workers.length;

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Lead creates work plan
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 1: Lead creating work plan`, { workerCount });

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
    for await (const message of this.sessionManager.executeTask(
      lead.id,
      planPrompt,
      {
        // Lead uses read-only tools (prevents git index locks)
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        model: this.config.model,
      }
    )) {
      this.handleMessage(lead.id, message);

      // Capture text output for JSON parsing
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            planJson += block.text;
          }
        }
      }

      if (this.state === 'stopped') return;
    }

    // Parse the lead's plan
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
        throw new Error('No JSON object found in lead output');
      }

      // Final cleanup
      cleanJson = cleanJson.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();

      const parsed = JSON.parse(cleanJson);

      // Check if lead says work is complete
      if (parsed.status === 'complete') {
        logger.info('Lead indicates all work is complete', { reason: parsed.reason });
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

      logger.info('Lead plan parsed', { assignmentCount: assignments.length });
    } catch (error) {
      logger.error('Failed to parse lead plan', { error, planJson: planJson.substring(0, 1000) });
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
      logger.warn('No valid assignments from lead, using fallback');
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
      const workerSession = workers.find(w => w.id === assignment.worker);
      if (!workerSession) {
        logger.warn('Worker session not found', { worker: assignment.worker });
        return Promise.resolve({ worker: assignment.worker, success: false, error: 'Session not found', result: undefined });
      }
      return this.executeWorkerAssignment(assignment, workerSession, iteration);
    });

    // ─────────────────────────────────────────────────────────────
    // Continuous merge: As each Worker completes, merge and reassign
    // ─────────────────────────────────────────────────────────────
    const pendingPromises = new Map(workerPromises.map((p, i) => [assignments[i].worker, p]));
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
          const branch = this.workBranch!;
          await this.runGit(['fetch', 'origin', workerId], this.repoPath!, { ignoreError: true });
          await this.runGit(['checkout', branch], this.repoPath!);
          try {
            await this.runGit(['merge', `origin/${workerId}`, '-m', `Merge ${workerId} branch`], this.repoPath!);
            this.stats.merges++;
            logger.info(`Merged: ${workerId}`);
          } catch {
            logger.warn(`Merge conflict for ${workerId}, auto-resolving`);
            // Accept theirs for content conflicts
            const unmergedList = await this.runGit(
              ['diff', '--name-only', '--diff-filter=U'],
              this.repoPath!,
              { ignoreError: true }
            );
            const unmergedFiles = unmergedList?.split('\n').filter(Boolean) || [];
            for (const file of unmergedFiles) {
              try {
                await this.runGit(['checkout', '--theirs', file], this.repoPath!, { ignoreError: true });
              } catch {
                await this.runGit(['checkout', '--ours', file], this.repoPath!, { ignoreError: true });
              }
            }
            await this.runGit(['add', '.'], this.repoPath!, { ignoreError: true });
            await this.runGit(['commit', '-m', `Merge ${workerId} (auto-resolved)`], this.repoPath!, { ignoreError: true });
            this.stats.conflicts++;
          }
          // Push after each merge
          await this.runGit(['push', 'origin', branch], this.repoPath!, { ignoreError: true });
        } catch (mergeErr) {
          logger.error(`Failed to merge ${workerId}`, { error: mergeErr });
        }

        // Ask Lead for new work for this Worker
        await this.runGit(['pull', 'origin', this.workBranch!, '--rebase'], this.repoPath!, { ignoreError: true });

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

        // Get new assignment from Lead
        logger.info(`Requesting new work for ${workerId}`, { reassignmentRound });
        let newAssignmentJson = '';
        try {
          for await (const message of this.sessionManager.executeTask(
            lead.id,
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
              logger.info(`Lead says work complete for ${workerId}`, { reason: parsed.reason });
              // Don't add back to pending - this Worker is done
            } else if (parsed.worker && parsed.area) {
              // Valid new assignment - start Worker on new work
              logger.info(`New assignment for ${workerId}`, { area: parsed.area });
              const workerSession = workers.find(w => w.id === workerId);
              if (workerSession) {
                const newPromise = this.executeWorkerAssignment(parsed, workerSession, iteration);
                pendingPromises.set(workerId, newPromise);
              }
            }
          }
        } catch (reassignError) {
          logger.warn(`Failed to get reassignment for ${workerId}`, { error: reassignError });
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
      await this.runGit(['checkout', branch], this.repoPath!);
      await this.runGit(['fetch', 'origin', branch], this.repoPath!, { ignoreError: true });
      await this.runGit(['rebase', `origin/${branch}`], this.repoPath!, { ignoreError: true });
      await this.runGit(['push', 'origin', branch], this.repoPath!);
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
   * Execute a Worker assignment
   */
  private async executeWorkerAssignment(
    assignment: { worker: string; area: string; files: string[]; tasks: string[]; acceptance: string },
    workerSession: Session,
    iteration: number
  ): Promise<{ worker: string; success: boolean; result?: string; error?: string }> {
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

    try {
      let result = '';
      for await (const message of this.sessionManager.executeTask(
        workerSession.id,
        workerPrompt,
        {
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          model: this.config.model,
        }
      )) {
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
          return { worker: assignment.worker, success: false, error: 'Orchestrator stopped' };
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

  private async runGit(
    args: string[],
    cwd: string,
    options?: { ignoreError?: boolean }
  ): Promise<string> {
    const { execa } = await import('execa');

    try {
      const result = await execa('git', args, { cwd });
      return result.stdout;
    } catch (error: any) {
      if (options?.ignoreError) {
        return error.stdout || '';
      }
      throw error;
    }
  }

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
