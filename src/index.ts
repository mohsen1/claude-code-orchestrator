/**
 * Claude Code Orchestrator
 *
 * Main module export - the orchestrator built on the Claude Agent SDK.
 * For CLI usage, run via `cco` command or `npm start`.
 *
 * Sessions maintain context across multiple tasks using the SDK's resume capability.
 */

// Core orchestrator
export { Orchestrator, createOrchestratorFromConfig } from './orchestrator.js';

// Session management
export { SessionManager, type SessionManagerConfig } from './session-manager.js';

// Agent definitions
export {
  createArchitectAgent,
  createTechLeadAgent,
  createWorkerAgent,
  createWorkerAgents,
  TOOL_SETS,
  type AgentDefinition,
} from './agents.js';

// Hooks
export {
  createGitSafetyHooks,
  createAuditHooks,
  createFileTrackingHooks,
  createSafetyHooks,
  createDefaultHooks,
  mergeHooks,
  GitOperationLock,
  gitLock,
  type HookInput,
  type HookContext,
  type HookCallback,
  type HookResult,
  type HookMatcher,
  type HooksConfig,
} from './hooks.js';

// Re-export types
export type {
  // Configuration
  OrchestratorConfig,
  ModelChoice,

  // Sessions
  Session,
  SessionRole,
  SessionStatus,
  SessionMetrics,
  TaskRecord,
  ToolCallRecord,

  // Tasks
  Task,
  TaskStatus,
  TaskPriority,
  TaskResult,

  // Team structure
  TeamStructure,
  TeamCluster,

  // Events
  OrchestratorEvent,
  OrchestratorEventType,
  ProgressStats,

  // Status
  OrchestratorState,
  OrchestratorStatus,

  // Persistence
  PersistedState,
  PersistedSession,

  // Auth
  AuthConfig,
} from './types.js';

// Re-export config
export { OrchestratorConfigSchema } from './config/schema.js';
export type { OrchestratorConfig as OrchestratorFileConfig } from './config/schema.js';

// Re-export utilities
export { logger, configureLogDirectory } from './utils/logger.js';
export { extractRepoName } from './utils/repo.js';
export { GitManager } from './git/worktree.js';
