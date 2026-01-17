/**
 * V3 Architecture Types - Agent SDK Based
 *
 * Key difference from v2: Sessions maintain context across multiple tasks
 * using the Agent SDK's resume capability.
 */

// ─────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────

export type ModelChoice = 'opus' | 'sonnet' | 'haiku';

export interface GitCloneOptions {
  /** Shallow clone with specified depth (e.g., 1 for latest commit only) */
  depth?: number;
  /** Clone only a single branch (saves bandwidth) */
  singleBranch?: boolean;
  /** Disable fetching of submodules */
  noSubmodules?: boolean;
}

export interface V3OrchestratorConfig {
  // Repository settings
  repositoryUrl: string;
  branch: string;
  workspaceDir: string;
  /** Path to local repo to copy from (faster than cloning) */
  localRepoPath?: string;
  gitCloneOptions?: GitCloneOptions;

  // Team structure
  workerCount: number;
  engineerManagerGroupSize: number; // threshold for hierarchy mode

  // Project definition
  projectDirection: string; // Overall goal (from PROJECT_DIRECTION.md or inline)
  projectName?: string;

  // Model configuration
  models: {
    director: ModelChoice;
    engineeringManager: ModelChoice;
    worker: ModelChoice;
  };

  // Session management
  sessionPersistPath?: string; // Where to save session state (default: alongside orchestrator.json)
  autoResume: boolean; // Resume previous session on restart

  // Execution settings
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  maxConcurrentWorkers: number;
  taskTimeoutMs: number;
  pollIntervalMs: number;
  maxRunDurationMinutes: number;

  // Auth
  authMode: 'oauth' | 'api-keys-first' | 'api-keys-only';

  // Observability
  auditLog: boolean;
  auditLogPath?: string;
  progressIntervalMs: number;
  logDirectory?: string;
}

// ─────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────

export type SessionRole =
  | 'director'
  | 'engineering-manager'
  | 'worker'
  | 'coordinator'; // For flat mode lead

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'expired'; // Session TTL exceeded

export interface Session {
  /** Internal session identifier (e.g., 'worker-1', 'em-2') */
  id: string;

  /** Claude session ID from the Agent SDK (set after first query) */
  claudeSessionId?: string;

  /** Role of this session in the orchestration */
  role: SessionRole;

  /** Current status */
  status: SessionStatus;

  /** Git worktree path for this session */
  worktreePath?: string;

  /** Git branch this session works on */
  branchName?: string;

  /** History of tasks executed in this session */
  taskHistory: TaskRecord[];

  /** Session metrics for context window management */
  metrics: SessionMetrics;

  /** Timestamps */
  createdAt: Date;
  lastActiveAt: Date;

  /** For forked sessions, the source session ID */
  forkedFrom?: string;

  /** API key index for rate limit rotation */
  authConfigIndex?: number;
}

export interface SessionMetrics {
  /** Estimated total tokens used (input + output) */
  totalTokensUsed: number;

  /** Number of tasks executed */
  taskCount: number;

  /** Number of tool calls made */
  toolCallCount: number;

  /** Last time context was summarized/compacted */
  lastCompactedAt?: Date;
}

export interface TaskRecord {
  /** Task prompt */
  prompt: string;

  /** Timestamps */
  startedAt: Date;
  completedAt?: Date;

  /** Result or error */
  result?: string;
  error?: string;

  /** Tool calls made during this task */
  toolCalls: ToolCallRecord[];

  /** Token usage for this task */
  inputTokens?: number;
  outputTokens?: number;
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  timestamp: Date;
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Task Types (compatible with v2)
// ─────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  description: string;
  requirements?: string[];
  filesToModify?: string[];
  acceptanceCriteria?: string[];
  priority: TaskPriority;
  status: TaskStatus;
  assignedSession?: string; // Session ID instead of worker number
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  retryCount: number;
  maxRetries: number;
}

export interface TaskResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  rateLimited?: boolean;
  sessionExpired?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Team Structure Types
// ─────────────────────────────────────────────────────────────

export type OrchestratorMode = 'flat' | 'hierarchy';

export interface TeamStructure {
  mode: OrchestratorMode;

  // Flat mode: single coordinator with workers
  coordinator?: Session;
  workers?: Session[];

  // Hierarchy mode: director → EMs → workers
  director?: Session;
  engineeringManagers?: EngineeringManagerTeam[];
}

export interface EngineeringManagerTeam {
  manager: Session;
  workers: Session[];
  assignedFeatures: string[];
}

// ─────────────────────────────────────────────────────────────
// Event Types (for streaming/observability)
// ─────────────────────────────────────────────────────────────

export type OrchestratorEventType =
  | 'orchestrator:start'
  | 'orchestrator:stop'
  | 'orchestrator:pause'
  | 'orchestrator:resume'
  | 'mode:selected'
  | 'session:created'
  | 'session:resumed'
  | 'session:forked'
  | 'session:expired'
  | 'session:compacted'
  | 'task:start'
  | 'task:complete'
  | 'task:error'
  | 'tool:start'
  | 'tool:complete'
  | 'file:modified'
  | 'git:operation'
  | 'text:stream'
  | 'progress';

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  timestamp: Date;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface ProgressStats {
  sessionsTotal: number;
  sessionsActive: number;
  sessionsIdle: number;
  sessionsCompleted: number;
  sessionsFailed: number;
  tasksCompleted: number;
  tasksPending: number;
  tasksFailed: number;
  filesModified: number;
  commitsCreated: number;
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────
// Orchestrator Status
// ─────────────────────────────────────────────────────────────

export type OrchestratorState = 'idle' | 'running' | 'paused' | 'stopped';

export interface OrchestratorStatus {
  state: OrchestratorState;
  mode: OrchestratorMode;
  startedAt?: Date;
  elapsedMs: number;
  sessions: {
    total: number;
    active: number;
    idle: number;
    completed: number;
    failed: number;
  };
  tasks: {
    completed: number;
    pending: number;
    failed: number;
  };
  git: {
    commits: number;
    merges: number;
    conflicts: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Persistence Types
// ─────────────────────────────────────────────────────────────

export interface PersistedState {
  version: 3;
  orchestratorId: string;
  startedAt: string; // ISO date
  lastSavedAt: string; // ISO date
  mode: OrchestratorMode;
  sessions: PersistedSession[];
  stats: ProgressStats;
}

export interface PersistedSession {
  id: string;
  claudeSessionId?: string;
  role: SessionRole;
  status: SessionStatus;
  worktreePath?: string;
  branchName?: string;
  metrics: SessionMetrics;
  taskCount: number;
  createdAt: string;
  lastActiveAt: string;
}

// ─────────────────────────────────────────────────────────────
// Auth Types (reused from v2)
// ─────────────────────────────────────────────────────────────

export interface AuthConfig {
  name?: string;
  apiKey?: string;
  /** Environment variables to set (e.g., z.ai format: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL }) */
  env?: Record<string, string>;
  envOverrides?: Record<string, string>;
}
