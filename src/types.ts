/**
 * Orchestrator Types - Agent SDK Based
 *
 * Simplified Lead/Worker architecture.
 * Sessions maintain context across multiple tasks using the Agent SDK's resume capability.
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

export interface OrchestratorConfig {
  // Repository settings
  repositoryUrl: string;
  branch: string;
  workspaceDir: string;
  /** Path to local repo to copy from (faster than cloning) */
  localRepoPath?: string;
  gitCloneOptions?: GitCloneOptions;
  /** If true, creates a unique run branch instead of committing directly to branch */
  useRunBranch?: boolean;

  // Team structure - hierarchical
  /** Total number of workers across all clusters */
  workerCount: number;
  /** Workers per Tech Lead (creates hierarchical model if > 1) */
  groupSize?: number;

  // Project definition
  projectDirection: string; // Overall goal (from PROJECT_DIRECTION.md or inline)
  projectName?: string;

  // Model configuration - single model for all agents
  model: ModelChoice;

  // Session management
  sessionPersistPath?: string; // Where to save session state
  autoResume: boolean; // Resume previous session on restart

  // Execution settings
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  taskTimeoutMs: number;
  pollIntervalMs: number;
  maxRunDurationMinutes: number;

  // Auth
  authMode: 'oauth' | 'api-keys-first' | 'api-keys-only';
  apiKeys?: AuthConfig[];

  // Observability
  auditLog: boolean;
  auditLogPath?: string;
  progressIntervalMs: number;
  logDirectory?: string;

  // Environment
  envFiles?: string[]; // Paths to env files to copy to each worker worktree
  env?: Record<string, string>; // Environment variables to set for all sessions

  // Git merge behavior
  mergeStrategy?: 'auto-resolve' | 'skip' | 'fail' | 'theirs' | 'ours' | 'union'; // How to handle merge conflicts
  maxAutoResolveConflicts?: number; // Max conflicts per iteration before aborting
}

// ─────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────

/** Hierarchical roles: Architect coordinates, Tech Leads manage features, Workers implement */
export type SessionRole = 'architect' | 'tech-lead' | 'worker';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'expired'; // Session TTL exceeded

export interface Session {
  /** Internal session identifier (e.g., 'lead', 'worker-1') */
  id: string;

  /** Claude session ID from the Agent SDK (set after first query) */
  claudeSessionId?: string;

  /** Role of this session in the orchestration */
  role: SessionRole;

  /** Current status */
  status: SessionStatus;

  /** Git worktree path for this session (workers only) */
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

  /** Flag to prevent recursive compaction triggers */
  isCompacting?: boolean;
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
// Task Types
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
  assignedSession?: string; // Session ID (e.g., 'worker-1')
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
// Team Structure Types - Hierarchical Cluster Model
// ─────────────────────────────────────────────────────────────

/** A cluster of sessions working on a feature branch */
export interface TeamCluster {
  /** Tech Lead session (manages feature branch, read-only access) */
  lead: Session;
  /** Feature branch name (e.g., 'feat/auth') */
  featureBranch: string;
  /** Worker sessions (each has a worktree off the feature branch) */
  workers: Session[];
}

/** Hierarchical team structure for scalable parallel development */
export interface TeamStructure {
  /** Architect session (runs on main branch, coordinates feature branches) */
  architect: Session;
  /** Feature clusters, each with a Tech Lead and Workers */
  clusters: TeamCluster[];
}

// ─────────────────────────────────────────────────────────────
// Event Types (for streaming/observability)
// ─────────────────────────────────────────────────────────────

export type OrchestratorEventType =
  | 'orchestrator:start'
  | 'orchestrator:stop'
  | 'orchestrator:pause'
  | 'orchestrator:resume'
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
  startedAt?: Date;
  elapsedMs: number;
  workerCount: number;
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
  version: 4; // Bumped for new architecture
  orchestratorId: string;
  startedAt: string; // ISO date
  lastSavedAt: string; // ISO date
  workerCount: number;
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
  authConfigIndex?: number;
}

// ─────────────────────────────────────────────────────────────
// Auth Types
// ─────────────────────────────────────────────────────────────

export interface AuthConfig {
  name?: string;
  apiKey?: string;
  /** Environment variables to set (e.g., z.ai format: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL }) */
  env?: Record<string, string>;
  envOverrides?: Record<string, string>;
}
