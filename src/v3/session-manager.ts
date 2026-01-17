/**
 * SessionManager - Core of the v3 Architecture
 *
 * Manages persistent Claude sessions with resume capability.
 * Each session maintains context across multiple task executions.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  query,
  type SDKMessage,
  type SDKResultSuccess,
  type SDKAssistantMessage,
  type SDKSystemMessage,
  type AgentDefinition,
  type Options as SDKOptions,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Session,
  SessionRole,
  SessionStatus,
  SessionMetrics,
  TaskRecord,
  ToolCallRecord,
  TaskResult,
  AuthConfig,
  PersistedState,
  PersistedSession,
  ProgressStats,
  OrchestratorMode,
} from './types.js';

// ─────────────────────────────────────────────────────────────
// Session Manager Configuration
// ─────────────────────────────────────────────────────────────

export interface SessionManagerConfig {
  /** Path to persist session state */
  persistPath: string;

  /** API keys for rate limit rotation */
  apiKeys: AuthConfig[];

  /** Auth mode */
  authMode: 'oauth' | 'api-keys-first' | 'api-keys-only';

  /** Default permission mode */
  permissionMode: 'bypassPermissions' | 'acceptEdits';

  /** Context window threshold for compaction (tokens) */
  compactThreshold: number;

  /** Whether to auto-save state */
  autoSave: boolean;

  /** Auto-save interval (ms) */
  autoSaveIntervalMs: number;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  persistPath: './sessions.json',
  apiKeys: [],
  authMode: 'oauth',
  permissionMode: 'bypassPermissions',
  compactThreshold: 80000, // ~80% of 100k context
  autoSave: true,
  autoSaveIntervalMs: 30000,
};

// ─────────────────────────────────────────────────────────────
// Session Manager Implementation
// ─────────────────────────────────────────────────────────────

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private config: SessionManagerConfig;
  private currentApiKeyIndex = 0;
  private autoSaveTimer?: NodeJS.Timeout;
  private orchestratorId: string;
  private startedAt: Date;
  private mode: OrchestratorMode = 'flat';

  constructor(config: Partial<SessionManagerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.orchestratorId = this.generateId();
    this.startedAt = new Date();

    if (this.config.autoSave) {
      this.startAutoSave();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new session
   */
  async createSession(
    id: string,
    role: SessionRole,
    worktreePath?: string,
    branchName?: string
  ): Promise<Session> {
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`);
    }

    const session: Session = {
      id,
      role,
      status: 'idle',
      worktreePath,
      branchName,
      taskHistory: [],
      metrics: {
        totalTokensUsed: 0,
        taskCount: 0,
        toolCallCount: 0,
      },
      createdAt: new Date(),
      lastActiveAt: new Date(),
      authConfigIndex: this.getNextAuthConfigIndex(),
    };

    this.sessions.set(id, session);
    this.emit('session:created', { sessionId: id, role, worktreePath });

    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions by role
   */
  getSessionsByRole(role: SessionRole): Session[] {
    return this.getAllSessions().filter((s) => s.role === role);
  }

  /**
   * Get idle sessions
   */
  getIdleSessions(): Session[] {
    return this.getAllSessions().filter((s) => s.status === 'idle');
  }

  // ─────────────────────────────────────────────────────────────
  // Task Execution
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute a task in a session, resuming context if available
   */
  async *executeTask(
    sessionId: string,
    prompt: string,
    options: {
      tools?: string[];  // Restrict available tools
      allowedTools?: string[];  // Auto-approve these tools
      agents?: Record<string, AgentDefinition>;
      model?: 'opus' | 'sonnet' | 'haiku';
      forkSession?: boolean;
    } = {}
  ): AsyncGenerator<SDKMessage, TaskResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Check if session needs context compaction
    if (session.metrics.totalTokensUsed > this.config.compactThreshold) {
      this.emit('session:needs-compaction', { sessionId });
      // Note: Actual compaction should be triggered by orchestrator
    }

    // Check if existing session is still resumable
    if (session.claudeSessionId) {
      const resumable = await this.isSessionResumable(session.claudeSessionId);
      if (!resumable) {
        this.emit('session:expired', { sessionId, claudeSessionId: session.claudeSessionId });
        session.claudeSessionId = undefined;
        session.status = 'expired';
      }
    }

    // Build query options
    const queryOptions: SDKOptions = {
      resume: session.claudeSessionId,
      forkSession: options.forkSession,
      // Restrict tools if specified (e.g., director can only read and delegate)
      tools: options.tools,
      allowedTools: options.allowedTools || [
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
      ],
      agents: options.agents,
      cwd: session.worktreePath,
      permissionMode: this.config.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits',
      allowDangerouslySkipPermissions: this.config.permissionMode === 'bypassPermissions',
      // Convert short model names to full names for the SDK
      model: options.model ? this.getFullModelName(options.model) : undefined,
      // Custom spawner that ensures node is in PATH (fixes Volta/nvm ENOENT issues)
      spawnClaudeCodeProcess: (spawnOpts: SpawnOptions): SpawnedProcess => {
        // Use the absolute path to node instead of relying on PATH
        const nodeAbsPath = process.execPath;
        const nodeBinDir = nodeAbsPath.replace(/\/node$/, '');
        const voltaShimDir = process.env.VOLTA_HOME ? `${process.env.VOLTA_HOME}/bin` : '';
        const env = {
          ...process.env,
          ...spawnOpts.env,
          PATH: `${nodeBinDir}:${voltaShimDir}:${spawnOpts.env?.PATH || process.env.PATH}`,
        };
        // Replace 'node' command with absolute path
        const command = spawnOpts.command === 'node' ? nodeAbsPath : spawnOpts.command;
        // Resolve cwd to absolute path
        const cwd = spawnOpts.cwd ? resolve(spawnOpts.cwd) : process.cwd();
        const child = spawn(command, spawnOpts.args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        return child as unknown as SpawnedProcess;
      },
    };

    // Update session state
    session.status = 'running';
    session.lastActiveAt = new Date();

    const taskRecord: TaskRecord = {
      prompt,
      startedAt: new Date(),
      toolCalls: [],
    };

    let result = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const startTime = Date.now();

    try {
      // Set the API key for this session
      this.setApiKeyForSession(session);

      this.emit('query:start', { sessionId, prompt: prompt.slice(0, 100), options: queryOptions });

      for await (const message of query({ prompt, options: queryOptions })) {
        this.emit('query:message', { sessionId, type: message?.type || 'unknown' });

        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          if (options.forkSession || !session.claudeSessionId) {
            session.claudeSessionId = message.session_id;
            this.emit('session:resumed', {
              sessionId,
              claudeSessionId: message.session_id,
              isNew: !options.forkSession,
            });
          }
        }

        // Track tool usage
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.name) {
              const toolCall: ToolCallRecord = {
                tool: block.name,
                input: (block.input as Record<string, unknown>) || {},
                timestamp: new Date(),
              };
              taskRecord.toolCalls.push(toolCall);
              session.metrics.toolCallCount++;

              this.emit('tool:start', {
                sessionId,
                tool: block.name,
                input: block.input,
              });
            }

            // Emit text for streaming
            if (block.type === 'text' && block.text) {
              this.emit('text:stream', { sessionId, text: block.text });
            }
          }

          // Track token usage
          if (message.message.usage) {
            inputTokens += message.message.usage.input_tokens || 0;
            outputTokens += message.message.usage.output_tokens || 0;
          }
        }

        // Capture final result from result message
        if (message.type === 'result' && 'result' in message) {
          result = (message as SDKResultSuccess).result;
        }

        // Yield message for external processing
        yield message;
      }

      // Update task record
      taskRecord.completedAt = new Date();
      taskRecord.result = result;
      taskRecord.inputTokens = inputTokens;
      taskRecord.outputTokens = outputTokens;

      // Update session metrics
      session.metrics.totalTokensUsed += inputTokens + outputTokens;
      session.metrics.taskCount++;
      session.taskHistory.push(taskRecord);
      session.status = 'idle';

      this.emit('task:complete', {
        sessionId,
        result,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        output: result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for rate limit
      if (this.isRateLimitError(error)) {
        this.emit('session:rate-limited', { sessionId });
        this.rotateApiKey();

        return {
          success: false,
          output: '',
          error: errorMessage,
          durationMs: Date.now() - startTime,
          rateLimited: true,
        };
      }

      // Update task record with error
      taskRecord.completedAt = new Date();
      taskRecord.error = errorMessage;
      session.taskHistory.push(taskRecord);
      session.status = 'failed';

      this.emit('task:error', { sessionId, error: errorMessage });

      return {
        success: false,
        output: '',
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a task and wait for completion (non-streaming)
   */
  async executeTaskSync(
    sessionId: string,
    prompt: string,
    options: {
      allowedTools?: string[];
      agents?: Record<string, AgentDefinition>;
      model?: 'opus' | 'sonnet' | 'haiku';
    } = {}
  ): Promise<TaskResult> {
    let result: TaskResult | undefined;

    for await (const _message of this.executeTask(sessionId, prompt, options)) {
      // Process all messages
    }

    // The generator returns the result
    const generator = this.executeTask(sessionId, prompt, options);
    let iterResult = await generator.next();
    while (!iterResult.done) {
      iterResult = await generator.next();
    }
    result = iterResult.value;

    return result || { success: false, output: '', error: 'No result', durationMs: 0 };
  }

  // ─────────────────────────────────────────────────────────────
  // Session Control
  // ─────────────────────────────────────────────────────────────

  /**
   * Fork a session to explore a different approach
   */
  async forkSession(sourceId: string, newId: string): Promise<Session> {
    const source = this.sessions.get(sourceId);
    if (!source) {
      throw new Error(`Source session ${sourceId} not found`);
    }

    if (!source.claudeSessionId) {
      throw new Error(`Source session ${sourceId} has no Claude session to fork`);
    }

    const forked: Session = {
      id: newId,
      claudeSessionId: source.claudeSessionId, // Will be forked on first query
      role: source.role,
      status: 'idle',
      worktreePath: source.worktreePath,
      branchName: source.branchName,
      taskHistory: [], // Fresh history for forked session
      metrics: {
        totalTokensUsed: source.metrics.totalTokensUsed, // Inherit context size
        taskCount: 0,
        toolCallCount: 0,
      },
      createdAt: new Date(),
      lastActiveAt: new Date(),
      forkedFrom: sourceId,
      authConfigIndex: this.getNextAuthConfigIndex(),
    };

    this.sessions.set(newId, forked);
    this.emit('session:forked', { sourceId, newId });

    return forked;
  }

  /**
   * Pause a session (marks it as paused, doesn't interrupt running task)
   */
  pauseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'idle') {
      session.status = 'paused';
      this.emit('session:paused', { sessionId });
    }
  }

  /**
   * Resume a paused session
   */
  resumeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'paused') {
      session.status = 'idle';
      this.emit('session:unpaused', { sessionId });
    }
  }

  /**
   * Destroy a session
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.emit('session:destroyed', { sessionId });
    }
  }

  /**
   * Destroy all sessions
   */
  destroyAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Session Health
  // ─────────────────────────────────────────────────────────────

  /**
   * Check if a Claude session is still resumable
   */
  async isSessionResumable(claudeSessionId: string): Promise<boolean> {
    // TODO: Implement actual check via SDK
    // For now, assume sessions are valid
    // This would need a lightweight query to verify
    return true;
  }

  /**
   * Compact a session's context by summarizing and creating a new session
   */
  async compactSession(
    sessionId: string,
    summaryPrompt?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.claudeSessionId) {
      return;
    }

    const defaultSummaryPrompt = `
Summarize the work done in this session so far:
- What files were created/modified?
- What features were implemented?
- What decisions were made and why?
- What's the current state of the task?

Be comprehensive but concise.
`;

    // Generate summary from current session
    let summary = '';
    for await (const msg of this.executeTask(
      sessionId,
      summaryPrompt || defaultSummaryPrompt
    )) {
      if ('result' in msg && msg.result) {
        summary = msg.result;
      }
    }

    // Clear Claude session ID to start fresh
    const oldSessionId = session.claudeSessionId;
    session.claudeSessionId = undefined;
    session.metrics.lastCompactedAt = new Date();

    // Reset token count (summary is now the context)
    session.metrics.totalTokensUsed = 0;

    this.emit('session:compacted', {
      sessionId,
      oldClaudeSessionId: oldSessionId,
      summaryLength: summary.length,
    });

    // Next task will start fresh session with summary as context
    // The orchestrator should prepend the summary to the next prompt
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────

  /**
   * Save state to disk
   */
  async saveState(): Promise<void> {
    const state: PersistedState = {
      version: 3,
      orchestratorId: this.orchestratorId,
      startedAt: this.startedAt.toISOString(),
      lastSavedAt: new Date().toISOString(),
      mode: this.mode,
      sessions: this.serializeSessions(),
      stats: this.getStats(),
    };

    const dir = dirname(this.config.persistPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(this.config.persistPath, JSON.stringify(state, null, 2));
    this.emit('state:saved', { path: this.config.persistPath });
  }

  /**
   * Load state from disk
   */
  async loadState(): Promise<boolean> {
    if (!existsSync(this.config.persistPath)) {
      return false;
    }

    try {
      const content = await readFile(this.config.persistPath, 'utf-8');
      const state: PersistedState = JSON.parse(content);

      if (state.version !== 3) {
        throw new Error(`Incompatible state version: ${state.version}`);
      }

      this.orchestratorId = state.orchestratorId;
      this.startedAt = new Date(state.startedAt);
      this.mode = state.mode;
      this.deserializeSessions(state.sessions);

      this.emit('state:loaded', {
        path: this.config.persistPath,
        sessionCount: state.sessions.length,
      });

      return true;
    } catch (error) {
      this.emit('state:load-error', { error });
      return false;
    }
  }

  private serializeSessions(): PersistedSession[] {
    return this.getAllSessions().map((session) => ({
      id: session.id,
      claudeSessionId: session.claudeSessionId,
      role: session.role,
      status: session.status,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      metrics: session.metrics,
      taskCount: session.taskHistory.length,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
    }));
  }

  private deserializeSessions(persisted: PersistedSession[]): void {
    for (const p of persisted) {
      const session: Session = {
        id: p.id,
        claudeSessionId: p.claudeSessionId,
        role: p.role,
        status: p.status,
        worktreePath: p.worktreePath,
        branchName: p.branchName,
        taskHistory: [], // History not persisted
        metrics: p.metrics,
        createdAt: new Date(p.createdAt),
        lastActiveAt: new Date(p.lastActiveAt),
      };
      this.sessions.set(p.id, session);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────

  getStats(): ProgressStats {
    const sessions = this.getAllSessions();
    return {
      sessionsTotal: sessions.length,
      sessionsActive: sessions.filter((s) => s.status === 'running').length,
      sessionsIdle: sessions.filter((s) => s.status === 'idle').length,
      sessionsCompleted: sessions.filter((s) => s.status === 'completed').length,
      sessionsFailed: sessions.filter((s) => s.status === 'failed').length,
      tasksCompleted: sessions.reduce((sum, s) => sum + s.taskHistory.filter((t) => t.result).length, 0),
      tasksPending: 0, // Tracked by orchestrator
      tasksFailed: sessions.reduce((sum, s) => sum + s.taskHistory.filter((t) => t.error).length, 0),
      filesModified: 0, // Would need to track from tool calls
      commitsCreated: 0, // Would need to track from git operations
      elapsedMs: Date.now() - this.startedAt.getTime(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Auth / Rate Limit Management
  // ─────────────────────────────────────────────────────────────

  private getNextAuthConfigIndex(): number {
    if (this.config.apiKeys.length === 0) {
      return 0;
    }
    const index = this.currentApiKeyIndex;
    this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.config.apiKeys.length;
    return index;
  }

  private setApiKeyForSession(session: Session): void {
    if (
      this.config.authMode === 'oauth' ||
      this.config.apiKeys.length === 0 ||
      session.authConfigIndex === undefined
    ) {
      // Use OAuth or no specific key
      delete process.env.ANTHROPIC_API_KEY;
      return;
    }

    const keyConfig = this.config.apiKeys[session.authConfigIndex];

    // Handle direct apiKey format
    if (keyConfig?.apiKey) {
      process.env.ANTHROPIC_API_KEY = keyConfig.apiKey;
    }

    // Handle env-based format (e.g., z.ai configs)
    if (keyConfig?.env) {
      for (const [key, value] of Object.entries(keyConfig.env)) {
        if (value !== undefined) {
          process.env[key] = String(value);
        }
      }
    }

    // Apply any additional env overrides
    if (keyConfig?.envOverrides) {
      for (const [key, value] of Object.entries(keyConfig.envOverrides)) {
        process.env[key] = value;
      }
    }
  }

  private rotateApiKey(): void {
    if (this.config.apiKeys.length === 0) {
      return;
    }
    this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.config.apiKeys.length;
    this.emit('auth:rotated', { newIndex: this.currentApiKeyIndex });
  }

  private isRateLimitError(error: unknown): boolean {
    const message = String(error);
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('quota exceeded') ||
      message.includes('too many requests')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────

  private generateId(): string {
    return `orch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      this.saveState().catch((err) => {
        this.emit('state:save-error', { error: err });
      });
    }, this.config.autoSaveIntervalMs);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }
  }

  /**
   * Set the orchestrator mode (flat or hierarchy)
   */
  setMode(mode: OrchestratorMode): void {
    this.mode = mode;
  }

  /**
   * Convert short model names to full model names for the SDK
   */
  private getFullModelName(shortName: string): string | undefined {
    const modelMap: Record<string, string> = {
      opus: 'claude-opus-4-5-20251101',
      sonnet: 'claude-sonnet-4-5-20250929' ,
      haiku: 'claude-haiku-4-5-20251001',
    };
    return modelMap[shortName] || shortName;
  }
}
