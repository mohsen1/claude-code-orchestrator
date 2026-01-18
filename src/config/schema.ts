import { z } from 'zod';

// Git URL pattern: supports HTTPS (https://...) and SSH (git@host:...)
const gitUrlPattern = /^(https?:\/\/|git@)[^\s]+$/;

/**
 * Orchestrator Configuration Schema
 *
 * Hierarchical Cluster architecture:
 * - Architect: coordinates on main branch
 * - Tech Leads: manage feature branches
 * - Workers: implement in parallel, each with own worktree
 *
 * When groupSize is set, creates hierarchical model:
 * - workerCount: total workers across all clusters
 * - groupSize: workers per Tech Lead (e.g., 20 workers / size 5 = 4 Tech Leads)
 */
export const OrchestratorConfigSchema = z
  .object({
    // Repository settings
    repositoryUrl: z.string().regex(gitUrlPattern, {
      message: 'Repository URL must be a valid git URL (HTTPS or SSH)',
    }),
    branch: z.string().default('main'),
    cloneDepth: z.number().int().min(1).optional(), // shallow clone depth
    useRunBranch: z.boolean().default(false), // If true, creates a unique branch for each run

    // Workspace settings
    workspaceDir: z.string().min(1).optional(), // Path to the workspace directory
    logDirectory: z.string().min(1).optional(),
    localRepoPath: z.string().min(1).optional(), // Path to local repo to copy from (faster than cloning)

    // Worker settings
    workerCount: z.number().int().min(1).max(100),
    groupSize: z.number().int().min(1).max(10).optional(), // Workers per Tech Lead (creates hierarchy if set)
    model: z.enum(['opus', 'sonnet', 'haiku']).default('opus'), // Single model for all agents

    // Authentication
    authMode: z.enum(['oauth', 'api-keys-first', 'api-keys-only']).default('oauth'),

    // Timing settings
    taskTimeoutMs: z.number().int().min(60000).default(600000), // 10 minutes default
    pollIntervalMs: z.number().int().min(1000).default(5000), // 5 seconds default

    // Cost limits
    maxToolUsesPerInstance: z.number().int().min(100).default(500),
    maxTotalToolUses: z.number().int().min(500).default(2000),
    maxRunDurationMinutes: z.number().int().min(1).default(120), // min 1 minute for testing

    // Environment
    envFiles: z.array(z.string()).optional(), // Paths to env files to copy to each worker worktree

    // Legacy fields (for backward compatibility migration)
    engineerManagerGroupSize: z.number().int().min(1).max(8).optional(),

    // Deprecated timing settings (kept for migration)
    timingBaseMs: z.number().int().min(5000).optional(),
    stuckThresholdMs: z.number().int().min(60000).optional(),
  })
  .transform((config) => {
    // Handle legacy engineerManagerGroupSize - map to new groupSize
    let groupSize = config.groupSize;

    if (config.engineerManagerGroupSize !== undefined && groupSize === undefined) {
      // Old config: engineerManagerGroupSize means workers per EM
      // New config: groupSize means workers per Tech Lead (same thing)
      groupSize = config.engineerManagerGroupSize;

      console.warn(
        `DEPRECATED: engineerManagerGroupSize is now groupSize.\n` +
          `Migrating: groupSize = ${groupSize}.\n` +
          `Update your config to: { "workerCount": ${config.workerCount}, "groupSize": ${groupSize} }`
      );
    }

    // Transform legacy timing settings
    const taskTimeoutMs =
      config.taskTimeoutMs ?? (config.stuckThresholdMs ? config.stuckThresholdMs * 3 : 600000);

    const pollIntervalMs =
      config.pollIntervalMs ?? (config.timingBaseMs ? Math.round(config.timingBaseMs / 6) : 5000);

    return {
      repositoryUrl: config.repositoryUrl,
      branch: config.branch,
      cloneDepth: config.cloneDepth,
      useRunBranch: config.useRunBranch,
      workspaceDir: config.workspaceDir,
      logDirectory: config.logDirectory,
      localRepoPath: config.localRepoPath,
      workerCount: config.workerCount,
      groupSize,
      model: config.model,
      authMode: config.authMode,
      taskTimeoutMs,
      pollIntervalMs,
      maxToolUsesPerInstance: config.maxToolUsesPerInstance,
      maxTotalToolUses: config.maxTotalToolUses,
      maxRunDurationMinutes: config.maxRunDurationMinutes,
      envFiles: config.envFiles,
    };
  });

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

/**
 * Auth configuration schema
 */
export const AuthConfigSchema = z.object({
  name: z.string().optional(),
  apiKey: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * API keys file schema
 */
export const ApiKeysFileSchema = z.array(AuthConfigSchema);
