import { z } from 'zod';

export const OrchestratorConfigSchema = z.object({
  repositoryUrl: z.string().url({ message: 'Repository URL must be a valid URL' }),
  branch: z.string().default('main'),
  workerCount: z.number().int().min(1).max(20),
  claudeConfigs: z.string(), // Glob pattern for Claude Code credential files
  hookServerPort: z.number().int().min(1024).max(65535).default(3000),
  healthCheckIntervalMs: z.number().int().min(5000).default(30000),
  rateLimitCheckIntervalMs: z.number().int().min(5000).default(10000),
  stuckThresholdMs: z.number().int().min(60000).default(300000), // 5 minutes
  maxToolUsesPerInstance: z.number().int().min(100).default(500),
  maxTotalToolUses: z.number().int().min(500).default(2000),
  maxRunDurationMinutes: z.number().int().min(10).default(120),
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

// Schema for validating Claude Code settings files
export const ClaudeSettingsSchema = z.object({
  // Core settings that may be present
  apiKey: z.string().optional(),
  // Allow additional unknown properties since Claude Code config format may vary
}).passthrough();

export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
