/**
 * V3 Orchestrator - Agent SDK Based
 *
 * Main orchestration engine using the Claude Agent SDK with session continuity.
 * Compatible with v2's CLI interface and e2e test expectations.
 */

import { EventEmitter } from 'events';
import { join, dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { SessionManager, type SessionManagerConfig } from './session-manager.js';
import {
  createTeamAgents,
  createLeadAgent,
  createWorkerAgent,
  type AgentDefinition,
} from './agents.js';
import { createDefaultHooks, gitLock, type HooksConfig } from './hooks.js';
import type {
  V3OrchestratorConfig,
  OrchestratorMode,
  OrchestratorStatus,
  OrchestratorState,
  OrchestratorEvent,
  Session,
  TeamStructure,
  EngineeringManagerTeam,
  AuthConfig,
  ProgressStats,
} from './types.js';
import { logger, configureLogDirectory } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<V3OrchestratorConfig> = {
  workerCount: 2,
  engineerManagerGroupSize: 4,
  models: {
    director: 'opus',
    engineeringManager: 'sonnet',
    worker: 'sonnet',
  },
  autoResume: true,
  permissionMode: 'bypassPermissions',
  maxConcurrentWorkers: 4,
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

export class OrchestratorV3 extends EventEmitter {
  private config: V3OrchestratorConfig;
  private sessionManager: SessionManager;
  private state: OrchestratorState = 'idle';
  private mode: OrchestratorMode = 'flat';
  private startedAt?: Date;
  private hooks: HooksConfig;

  // Team structure
  private teamStructure?: TeamStructure;

  // Git state
  private repoPath?: string;

  // API keys
  private apiKeys: AuthConfig[] = [];

  // Stats
  private stats = {
    commits: 0,
    merges: 0,
    conflicts: 0,
  };

  constructor(config: Partial<V3OrchestratorConfig> & Pick<V3OrchestratorConfig, 'repositoryUrl' | 'branch' | 'workspaceDir' | 'projectDirection'>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as V3OrchestratorConfig;

    // Determine mode based on worker count vs EM group size
    this.mode = this.config.workerCount > this.config.engineerManagerGroupSize
      ? 'hierarchy'
      : 'flat';

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

    logger.info('Starting V3 Orchestrator', {
      mode: this.mode,
      workerCount: this.config.workerCount,
      branch: this.config.branch,
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
   * This is the key v3 feature - session continuity!
   */
  async continue(prompt: string): Promise<void> {
    if (!this.teamStructure) {
      throw new Error('No team structure - orchestrator not started');
    }

    const leadSession = this.mode === 'flat'
      ? this.teamStructure.coordinator
      : this.teamStructure.director;

    if (!leadSession) {
      throw new Error('No lead session found');
    }

    logger.info('Continuing orchestration with new prompt', {
      sessionId: leadSession.id,
      promptLength: prompt.length,
    });

    // Execute continuation on the lead session
    for await (const message of this.sessionManager.executeTask(
      leadSession.id,
      prompt,
      this.getLeadSessionOptions()
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
      mode: this.mode,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
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

      // Use rsync to copy (handles symlinks, ignores errors better than cp)
      // -a = archive mode, -H = preserve hard links, --exclude to skip problematic dirs
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

    logger.info('Repository setup complete', { repoPath: this.repoPath });
  }

  private async createTeamStructure(): Promise<void> {
    logger.info('Creating team structure', { mode: this.mode });

    if (this.mode === 'flat') {
      await this.createFlatStructure();
    } else {
      await this.createHierarchyStructure();
    }

    this.sessionManager.setMode(this.mode);
    this.emitEvent('mode:selected', { mode: this.mode, details: this.teamStructure! });
  }

  private async createFlatStructure(): Promise<void> {
    // Get or create coordinator session
    let coordinator = this.sessionManager.getSession('coordinator');
    if (!coordinator) {
      coordinator = await this.sessionManager.createSession(
        'coordinator',
        'coordinator',
        this.repoPath,
        this.config.branch
      );
    }

    // Get or create worker sessions
    const workers: Session[] = [];
    for (let i = 1; i < this.config.workerCount; i++) {
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
      mode: 'flat',
      coordinator,
      workers,
    };
  }

  private async createHierarchyStructure(): Promise<void> {
    // Get or create director session
    let director = this.sessionManager.getSession('director');
    if (!director) {
      director = await this.sessionManager.createSession(
        'director',
        'director',
        this.repoPath,
        this.config.branch
      );
    }

    // Calculate EM count
    const emCount = Math.ceil(
      this.config.workerCount / this.config.engineerManagerGroupSize
    );

    // Get or create EM teams
    const engineeringManagers: EngineeringManagerTeam[] = [];
    let workerIndex = 1;

    for (let emId = 1; emId <= emCount; emId++) {
      const emSessionId = `em-${emId}`;
      let manager = this.sessionManager.getSession(emSessionId);
      if (!manager) {
        const emPath = await this.createWorktree(emSessionId);
        manager = await this.sessionManager.createSession(
          emSessionId,
          'engineering-manager',
          emPath,
          emSessionId
        );
      }

      // In hierarchy mode, workers are SDK subagents (not separate sessions)
      // They run within the EM's context, so no worker sessions/worktrees needed
      const workersInTeam = Math.min(
        this.config.engineerManagerGroupSize,
        this.config.workerCount - (emId - 1) * this.config.engineerManagerGroupSize
      );
      workerIndex += workersInTeam;

      engineeringManagers.push({
        manager,
        workers: [], // Workers are SDK subagents, not managed sessions
        assignedFeatures: [],
      });
    }

    this.teamStructure = {
      mode: 'hierarchy',
      director,
      engineeringManagers,
    };
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

    if (this.mode === 'flat') {
      await this.runFlatOrchestration(projectDirection);
    } else {
      await this.runHierarchyOrchestration(projectDirection);
    }
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

  private async runFlatOrchestration(projectDirection: string): Promise<void> {
    const coordinator = this.teamStructure!.coordinator!;

    // Build the initial prompt for the coordinator
    const initialPrompt = `
# Project Direction

${projectDirection}

# Your Team

You have ${this.config.workerCount} workers (including yourself as worker-0):
- worker-1 through worker-${this.config.workerCount - 1} are available for delegation

# Instructions

1. Analyze the project requirements above
2. Create a task breakdown
3. Delegate tasks to your workers
4. Implement your own assigned portion
5. Review and merge worker contributions
6. Ensure the project compiles and tests pass

Start by reading the codebase and creating your plan.
`;

    // Create worker subagents
    const agents = createTeamAgents({
      mode: 'flat',
      workerCount: this.config.workerCount,
      engineerManagerGroupSize: this.config.engineerManagerGroupSize,
      branch: this.config.branch,
    });

    logger.info('Starting flat mode orchestration');

    // Run the coordinator with streaming
    for await (const message of this.sessionManager.executeTask(
      coordinator.id,
      initialPrompt,
      {
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
        agents,
        model: this.config.models.worker,
      }
    )) {
      this.handleMessage(coordinator.id, message);

      // Check for stop/pause
      if (this.state === 'stopped') break;
      while (this.state === 'paused') {
        await this.sleep(1000);
      }
    }
  }

  private async runHierarchyOrchestration(projectDirection: string): Promise<void> {
    const director = this.teamStructure!.director!;
    const emCount = this.teamStructure!.engineeringManagers!.length;
    const ems = this.teamStructure!.engineeringManagers!;

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
      // This allows PROJECT_DIRECTION.md updates to be picked up
      try {
        const branch = this.config.branch;
        await this.runGit(['fetch', 'origin', branch], this.repoPath!, { ignoreError: true });
        await this.runGit(['checkout', branch], this.repoPath!, { ignoreError: true });
        await this.runGit(['pull', 'origin', branch], this.repoPath!, { ignoreError: true });
        // Re-read PROJECT_DIRECTION.md in case it was updated
        const directionPath = join(this.repoPath!, 'PROJECT_DIRECTION.md');
        if (existsSync(directionPath)) {
          projectDirection = await readFile(directionPath, 'utf-8');
          logger.info('Refreshed PROJECT_DIRECTION.md');
        }
      } catch (pullError) {
        logger.warn('Failed to pull latest changes', { error: pullError });
      }

      try {
        await this.runSingleIteration(director, ems, emCount, projectDirection, iteration);
      } catch (error: any) {
        logger.error(`Iteration ${iteration} failed`, { error: error.message });
        // Continue to next iteration unless it's a fatal error
        if (error.message?.includes('No more work')) {
          logger.info('Director indicated no more work to do');
          break;
        }
      }

      // Brief pause between iterations
      await this.sleep(5000);
    }

    logger.info('Hierarchy orchestration complete', {
      totalIterations: iteration,
      totalElapsedMinutes: Math.floor((Date.now() - startTime) / 60000),
      stats: this.stats,
    });
  }

  private async runSingleIteration(
    director: Session,
    ems: EngineeringManagerTeam[],
    emCount: number,
    projectDirection: string,
    iteration: number
  ): Promise<void> {
    // ─────────────────────────────────────────────────────────────
    // Phase 1: Director creates work plan
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 1: Director creating work plan`, { emCount });

    const planPrompt = `
# Project Direction

${projectDirection}

# Current Status

This is iteration ${iteration} of continuous development.
${iteration > 1 ? 'Previous iterations have already made progress. Focus on REMAINING work that has not been completed yet.' : 'This is the first iteration.'}

# Your Task

Create a JSON work plan for ${emCount} Engineering Managers (em-1 through em-${emCount}).
Each EM will work IN PARALLEL on their assigned area.

IMPORTANT:
- Read the codebase to understand what work remains
- Check test results, build status, or other project-specific verification methods
- Only report complete when ALL documented tasks are verifiably done
- If there are still failing tests or incomplete features, assign that work

Output ONLY valid JSON (no markdown code blocks):
{"assignments": [{"em": "em-1", "area": "...", "files": [...], "tasks": [...], "acceptance": "..."}]}

If ALL work is truly complete (verified via tests/builds), output:
{"status": "complete", "reason": "Explanation of how completion was verified"}

Read the project direction and codebase, then output the JSON plan.
`;

    let planJson = '';
    for await (const message of this.sessionManager.executeTask(
      director.id,
      planPrompt,
      {
        // Restrict director to read-only tools (output JSON as text, not Write)
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        model: this.config.models.director,
      }
    )) {
      this.handleMessage(director.id, message);

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

    // Parse the director's plan - be flexible about format
    type Assignment = { em: string; area: string; files: string[]; tasks: string[]; acceptance: string };
    let assignments: Assignment[] = [];

    try {
      // Extract JSON from the text - try multiple approaches
      let cleanJson = '';

      // Approach 1: Try to extract from markdown code blocks first
      const codeBlockMatch = planJson.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        cleanJson = codeBlockMatch[1].trim();
      }

      // Approach 2: If no code block or empty, try to find bare JSON object
      if (!cleanJson) {
        const jsonMatch = planJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanJson = jsonMatch[0];
        }
      }

      if (!cleanJson) {
        throw new Error('No JSON object found in director output');
      }

      // Final cleanup - remove any remaining markdown artifacts
      cleanJson = cleanJson.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();

      const parsed = JSON.parse(cleanJson);

      // Check if director says work is complete
      if (parsed.status === 'complete') {
        logger.info('Director indicates all work is complete', { reason: parsed.reason });
        throw new Error('No more work: ' + (parsed.reason || 'All tasks done'));
      }

      // Handle different JSON structures the director might use
      if (parsed.assignments && Array.isArray(parsed.assignments)) {
        // Expected format: { assignments: [...] }
        // Validate and normalize each assignment
        for (let i = 0; i < parsed.assignments.length; i++) {
          const raw = parsed.assignments[i];
          if (!raw || typeof raw !== 'object') continue;

          assignments.push({
            em: raw.em || `em-${i + 1}`,
            area: String(raw.area || raw.title || raw.description || `Area ${i + 1}`),
            files: Array.isArray(raw.files) ? raw.files : ['src/'],
            tasks: Array.isArray(raw.tasks) ? raw.tasks : ['Implement assigned features'],
            acceptance: String(raw.acceptance || 'Tests pass'),
          });
        }
      } else if (parsed['em-1'] || parsed['em-2'] || parsed['em-3']) {
        // Alternative format: { "em-1": {...}, "em-2": {...} }
        for (const [key, value] of Object.entries(parsed)) {
          if (key.startsWith('em-') && typeof value === 'object' && value !== null) {
            const emData = value as Record<string, any>;
            const focusAreas = Array.isArray(emData.focus_areas) ? emData.focus_areas : [];
            const priorityIssues = Array.isArray(emData.priority_issues) ? emData.priority_issues : [];
            assignments.push({
              em: key,
              area: String(emData.title || emData.area || focusAreas[0] || 'General'),
              files: Array.isArray(emData.primary_files) ? emData.primary_files :
                     Array.isArray(emData.files) ? emData.files : [],
              tasks: priorityIssues.length > 0
                ? priorityIssues.map((i: any) => String(i.issue || i.description || i))
                : Array.isArray(emData.tasks) ? emData.tasks : ['Implement assigned features'],
              acceptance: String(emData.acceptance || emData.success_criteria || 'All tests pass'),
            });
          }
        }
      }

      logger.info('Director plan parsed', { assignmentCount: assignments.length });
    } catch (error) {
      logger.error('Failed to parse director plan', { error, planJson: planJson.substring(0, 1000) });
      // Fallback: create default assignments for each EM
      logger.warn('Using fallback plan assignments');
      for (let i = 1; i <= emCount; i++) {
        assignments.push({
          em: `em-${i}`,
          area: `Tier ${i - 1} issues from PROJECT_DIRECTION.md`,
          files: ['src/'],
          tasks: ['Read PROJECT_DIRECTION.md', 'Implement assigned tier fixes', 'Run tests'],
          acceptance: 'Tests pass and code compiles',
        });
      }
    }

    // Ensure we have assignments for all EMs
    if (assignments.length === 0) {
      logger.warn('No valid assignments from director, using fallback');
      for (let i = 1; i <= emCount; i++) {
        assignments.push({
          em: `em-${i}`,
          area: `Tier ${i - 1} issues from PROJECT_DIRECTION.md`,
          files: ['src/'],
          tasks: ['Read PROJECT_DIRECTION.md', 'Implement assigned tier fixes', 'Run tests'],
          acceptance: 'Tests pass and code compiles',
        });
      }
    }

    const plan = { assignments };

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Execute EMs in parallel
    // ─────────────────────────────────────────────────────────────
    logger.info(`[Iteration ${iteration}] Phase 2: Spawning EMs in parallel`, {
      emCount: plan.assignments.length,
      assignments: plan.assignments.map(a => ({ em: a.em, area: a.area }))
    });

    const emPromises = plan.assignments.map((assignment) => {
      const emSession = ems.find(e => e.manager.id === assignment.em);
      if (!emSession) {
        logger.warn('EM session not found', { em: assignment.em });
        return Promise.resolve({ em: assignment.em, success: false, error: 'Session not found', result: undefined });
      }
      return this.executeEmAssignment(assignment, emSession, ems, iteration);
    });

    // ─────────────────────────────────────────────────────────────
    // Continuous merge: As each EM completes, merge and reassign
    // ─────────────────────────────────────────────────────────────
    const pendingPromises = new Map(emPromises.map((p, i) => [plan.assignments[i].em, p]));
    const completedEms: string[] = [];
    let reassignmentRound = 0;

    while (pendingPromises.size > 0 && this.state !== 'stopped') {
      // Wait for any EM to complete
      const raceResult = await Promise.race(
        Array.from(pendingPromises.entries()).map(async ([emId, promise]) => {
          const result = await promise;
          return { emId, result };
        })
      );

      const { emId, result } = raceResult;
      pendingPromises.delete(emId);
      completedEms.push(emId);

      if (result.success) {
        // Immediately merge this EM's branch
        logger.info(`EM completed, merging: ${emId}`, { resultLength: result.result?.length });
        try {
          const branch = this.config.branch;
          await this.runGit(['fetch', 'origin', emId], this.repoPath!, { ignoreError: true });
          await this.runGit(['checkout', branch], this.repoPath!);
          try {
            await this.runGit(['merge', `origin/${emId}`, '-m', `Merge ${emId} branch`], this.repoPath!);
            this.stats.merges++;
            logger.info(`Merged: ${emId}`);
          } catch {
            logger.warn(`Merge conflict for ${emId}, auto-resolving`);
            // Smarter conflict resolution:
            // - For content conflicts: accept theirs (EM's version)
            // - For deleted files: keep ours (don't delete new files)
            // Get list of unmerged files and resolve each appropriately
            const unmergedList = await this.runGit(
              ['diff', '--name-only', '--diff-filter=U'],
              this.repoPath!,
              { ignoreError: true }
            );
            const unmergedFiles = unmergedList?.split('\n').filter(Boolean) || [];
            for (const file of unmergedFiles) {
              // Accept theirs for content conflicts, but check if it's a delete
              try {
                await this.runGit(['checkout', '--theirs', file], this.repoPath!, { ignoreError: true });
              } catch {
                // If checkout --theirs fails, file was deleted by them - keep ours
                await this.runGit(['checkout', '--ours', file], this.repoPath!, { ignoreError: true });
              }
            }
            await this.runGit(['add', '.'], this.repoPath!, { ignoreError: true });
            await this.runGit(['commit', '-m', `Merge ${emId} (auto-resolved)`], this.repoPath!, { ignoreError: true });
            this.stats.conflicts++;
          }
          // Push after each merge
          await this.runGit(['push', 'origin', branch], this.repoPath!, { ignoreError: true });
        } catch (mergeErr) {
          logger.error(`Failed to merge ${emId}`, { error: mergeErr });
        }

        // Ask director for new work for this EM
        // First pull latest (in case PROJECT_DIRECTION.md was updated externally)
        await this.runGit(['pull', 'origin', this.config.branch, '--rebase'], this.repoPath!, { ignoreError: true });

        reassignmentRound++;
        const newWorkPrompt = `
EM ${emId} has completed their work and merged to ${this.config.branch}.

Current status:
- ${completedEms.length} EMs have completed at least one task
- ${pendingPromises.size} EMs still working on their current task
- Total reassignments so far: ${reassignmentRound}

Review PROJECT_DIRECTION.md and the current codebase state (git pull was done).
Check what work remains - run tests, check conformance, etc.

If there is MORE work to do, output a new assignment for ${emId}:
{"em": "${emId}", "area": "...", "files": [...], "tasks": [...], "acceptance": "..."}

If ALL work is truly complete (verified), output:
{"status": "complete", "reason": "Explanation"}

Output ONLY valid JSON (no markdown).
`;

        // Get new assignment from director
        logger.info(`Requesting new work for ${emId}`, { reassignmentRound });
        let newAssignmentJson = '';
        try {
          for await (const message of this.sessionManager.executeTask(
            director.id,
            newWorkPrompt,
            { tools: ['Read', 'Glob', 'Grep', 'Bash'], allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], model: this.config.models.director }
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
              logger.info(`Director says work complete for ${emId}`, { reason: parsed.reason });
              // Don't add back to pending - this EM is done
            } else if (parsed.em && parsed.area) {
              // Valid new assignment - start EM on new work
              logger.info(`New assignment for ${emId}`, { area: parsed.area });
              const emSession = ems.find(e => e.manager.id === emId);
              if (emSession) {
                const newPromise = this.executeEmAssignment(parsed, emSession, ems, iteration);
                pendingPromises.set(emId, newPromise);
              }
            }
          }
        } catch (reassignError) {
          logger.warn(`Failed to get reassignment for ${emId}`, { error: reassignError });
        }
      } else {
        logger.error(`EM failed: ${emId}`, { error: result.error });
      }
    }

    const successful = completedEms;
    const failed: string[] = [];

    logger.info('All EMs completed', {
      successful: successful.length,
      failed: failed.length,
    });

    // Final sync - ensure branch is pushed
    const branch = this.config.branch;
    try {
      await this.runGit(['checkout', branch], this.repoPath!);
      await this.runGit(['fetch', 'origin', branch], this.repoPath!, { ignoreError: true });
      await this.runGit(['rebase', `origin/${branch}`], this.repoPath!, { ignoreError: true });
      await this.runGit(['push', 'origin', branch], this.repoPath!);
      logger.info(`[Iteration ${iteration}] Final push to origin complete`);
    } catch (error) {
      logger.error(`[Iteration ${iteration}] Final push failed`, { error });
    }

    logger.info(`[Iteration ${iteration}] Complete`, {
      successful: successful.length,
      failed: failed.length,
      stats: this.stats,
    });
  }

  private getLeadSessionOptions(): {
    allowedTools: string[];
    agents: Record<string, AgentDefinition>;
    model: 'opus' | 'sonnet' | 'haiku';
  } {
    const agents = createTeamAgents({
      mode: this.mode,
      workerCount: this.config.workerCount,
      engineerManagerGroupSize: this.config.engineerManagerGroupSize,
      branch: this.config.branch,
    });

    if (this.mode === 'flat') {
      return {
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
        agents,
        model: this.config.models.worker,
      };
    } else {
      return {
        allowedTools: ['Read', 'Glob', 'Grep', 'Task'],
        agents,
        model: this.config.models.director,
      };
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

  /**
   * Execute an EM assignment - reusable for initial and reassignment
   */
  private async executeEmAssignment(
    assignment: { em: string; area: string; files: string[]; tasks: string[]; acceptance: string },
    emSession: EngineeringManagerTeam,
    _ems: EngineeringManagerTeam[],
    iteration: number
  ): Promise<{ em: string; success: boolean; result?: string; error?: string }> {
    // Get worker IDs for this EM's team
    const emIndex = parseInt(assignment.em.replace('em-', ''));
    const workersPerEM = this.config.engineerManagerGroupSize;
    const startWorker = (emIndex - 1) * workersPerEM + 1;
    const endWorker = Math.min(startWorker + workersPerEM - 1, this.config.workerCount);
    const workerIds: string[] = [];
    for (let w = startWorker; w <= endWorker; w++) {
      workerIds.push(`worker-${w}`);
    }

    const emPrompt = `
# Your Assignment: ${assignment.area}

You are ${assignment.em}, an Engineering Manager with a team of ${workerIds.length} workers.

## Your Team
You can delegate tasks to these workers using the Task tool:
${workerIds.map(w => `- ${w}`).join('\n')}

## Files to Focus On
${assignment.files.map(f => `- ${f}`).join('\n')}

## Tasks
${assignment.tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Acceptance Criteria
${assignment.acceptance}

## WORKFLOW - Delegate to Workers!

1. **DELEGATE tasks to your workers** using the Task tool:
   - Each worker should get a focused, independent task
   - Be specific about what files to modify and what changes to make
   - Workers work in parallel - delegate to all of them at once!

2. **Wait for workers to complete**, then:
   - Review their work
   - Make any necessary fixes yourself
   - Commit and push the combined result

Example delegation:
\`\`\`
Use Task tool with subagent_type="${workerIds[0]}" and prompt:
"Implement X in file Y. Specifically: <detailed instructions>"
\`\`\`

## CRITICAL RULES
- DELEGATE to workers - don't do everything yourself!
- Workers implement code, you coordinate and review
- DO NOT create markdown files or documentation
- Push your branch (${assignment.em}) when done

**START BY DELEGATING TASKS TO YOUR ${workerIds.length} WORKERS NOW.**
`;

    logger.info(`Starting EM: ${assignment.em}`, { area: assignment.area, iteration });

    // Create worker agents for this EM
    const workerAgents: Record<string, import('./agents.js').AgentDefinition> = {};
    for (const workerId of workerIds) {
      const workerNum = parseInt(workerId.replace('worker-', ''));
      workerAgents[workerId] = {
        description: `Worker ${workerNum}: Implements code changes as assigned.`,
        prompt: `You are ${workerId}, a software engineer. Implement the assigned task completely.
- Write clean, production-ready code
- Make atomic commits with clear messages
- Focus only on your assigned task
- Do NOT create documentation files`,
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        model: 'sonnet',
      };
    }

    try {
      let result = '';
      const workerDelegations: string[] = [];
      for await (const message of this.sessionManager.executeTask(
        emSession.manager.id,
        emPrompt,
        {
          tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
          agents: workerAgents,
          model: this.config.models.engineeringManager,
        }
      )) {
        // Log EM-specific tool calls with details
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
              } else if (block.name === 'Task') {
                const workerId = String(input?.subagent_type || 'unknown');
                const promptPreview = String(input?.prompt || '').slice(0, 100).replace(/\n/g, ' ');
                details = `${workerId}`;
                workerDelegations.push(workerId);
                logger.info('Worker delegation', { em: assignment.em, worker: workerId, task: promptPreview + '...' });
              }
              logger.info('Tool call', { sessionId: assignment.em, tool: block.name, details: details || undefined });
              this.emitEvent('tool:start', { sessionId: assignment.em, tool: block.name, input: block.input });
            }
            if (block.type === 'text') {
              result += block.text;
            }
          }
        }

        // Log tool results
        if (message.type === 'user' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              if (content.length > 200) {
                logger.info('Worker result', {
                  em: assignment.em,
                  resultPreview: content.slice(0, 150).replace(/\n/g, ' ') + '...',
                  resultLength: content.length,
                });
              }
            }
          }
        }

        if (this.state === 'stopped') {
          return { em: assignment.em, success: false, error: 'Orchestrator stopped' };
        }
      }

      logger.info(`EM completed: ${assignment.em}`, {
        resultLength: result.length,
        workersDelegated: workerDelegations.length,
        workers: workerDelegations.length > 0 ? workerDelegations : undefined,
      });
      return { em: assignment.em, success: true, result };
    } catch (error: any) {
      const errorMessage = error?.message || error?.shortMessage || String(error);
      logger.error(`EM failed: ${assignment.em}`, { error: errorMessage });
      return { em: assignment.em, success: false, error: errorMessage };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────

/**
 * Create an orchestrator from a config file (v2-compatible interface)
 */
export async function createOrchestratorFromConfig(
  configPath: string,
  workspaceDir: string
): Promise<OrchestratorV3> {
  const content = await readFile(configPath, 'utf-8');
  const config = JSON.parse(content);

  // Map v2 config format to v3
  const v3Config: Partial<V3OrchestratorConfig> & Pick<V3OrchestratorConfig, 'repositoryUrl' | 'branch' | 'workspaceDir' | 'projectDirection'> = {
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    workspaceDir,
    localRepoPath: config.localRepoPath,
    projectDirection: '', // Will be loaded from PROJECT_DIRECTION.md
    workerCount: config.workerCount || 2,
    engineerManagerGroupSize: config.engineerManagerGroupSize || 4,
    authMode: config.authMode || 'oauth',
    taskTimeoutMs: config.taskTimeoutMs || 600000,
    pollIntervalMs: config.pollIntervalMs || 5000,
    maxRunDurationMinutes: config.maxRunDurationMinutes || 120,
  };

  return new OrchestratorV3(v3Config);
}
