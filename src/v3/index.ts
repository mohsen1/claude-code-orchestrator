/**
 * V3 Orchestrator - Agent SDK Based
 *
 * This module exports the v3 architecture built on the Claude Agent SDK.
 * The key innovation is session continuity - workers maintain context across
 * multiple tasks using the SDK's resume capability.
 *
 * ## Usage
 *
 * ```typescript
 * import { OrchestratorV3, createOrchestratorFromConfig } from './v3';
 *
 * // Create from config file (v2-compatible)
 * const orchestrator = await createOrchestratorFromConfig(
 *   './orchestrator.json',
 *   './workspace'
 * );
 *
 * // Or create directly
 * const orchestrator = new OrchestratorV3({
 *   repositoryUrl: 'git@github.com:user/repo.git',
 *   branch: 'main',
 *   workspaceDir: './workspace',
 *   projectDirection: '...',
 *   workerCount: 4,
 * });
 *
 * // Start orchestration
 * await orchestrator.start();
 *
 * // Later: continue with new instructions (session continuity!)
 * await orchestrator.continue('Now add authentication to all endpoints');
 * ```
 */

// Core orchestrator
export { OrchestratorV3, createOrchestratorFromConfig } from './orchestrator.js';

// Session management
export { SessionManager, type SessionManagerConfig } from './session-manager.js';

// Agent definitions
export {
  createWorkerAgent,
  createEngineeringManagerAgent,
  createDirectorAgent,
  createCoordinatorAgent,
  createTeamAgents,
  createLeadAgent,
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

// Types
export type {
  // Configuration
  V3OrchestratorConfig,
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
  OrchestratorMode,
  TeamStructure,
  EngineeringManagerTeam,

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
