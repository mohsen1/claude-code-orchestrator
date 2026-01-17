/**
 * SDK Hooks
 *
 * Provides hook configurations for:
 * - Git operation serialization (prevent index.lock conflicts)
 * - Audit logging
 * - Progress tracking
 */

import { EventEmitter } from 'events';

// ─────────────────────────────────────────────────────────────
// Types (placeholder until SDK is installed)
// ─────────────────────────────────────────────────────────────

export interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface HookContext {
  [key: string]: unknown;
}

export type HookCallback = (
  input: HookInput,
  toolUseId: string,
  context: HookContext
) => Promise<HookResult>;

export interface HookResult {
  /** If set, blocks the tool call with this message */
  block?: string;
  /** Modified input to use instead */
  modifiedInput?: Record<string, unknown>;
}

export interface HookMatcher {
  /** Regex pattern to match tool names */
  matcher: string;
  /** Hook callbacks to run */
  hooks: HookCallback[];
}

export interface HooksConfig {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
}

// ─────────────────────────────────────────────────────────────
// Git Operation Queue (for serialization)
// ─────────────────────────────────────────────────────────────

/**
 * Simple async lock for serializing git operations
 */
export class GitOperationLock {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

// Global git lock instance
const gitLock = new GitOperationLock();

// ─────────────────────────────────────────────────────────────
// Hook Factories
// ─────────────────────────────────────────────────────────────

/**
 * Create hooks for git operation serialization
 */
export function createGitSafetyHooks(emitter?: EventEmitter): HooksConfig {
  const preHook: HookCallback = async (input, toolUseId, context) => {
    const command = (input.tool_input?.command as string) || '';

    // Check if this is a git command
    if (isGitCommand(command)) {
      emitter?.emit('git:waiting', { toolUseId, command });

      // Acquire lock before git operation
      await gitLock.acquire();
      context.gitLockAcquired = true;

      emitter?.emit('git:acquired', { toolUseId, command });
    }

    return {};
  };

  const postHook: HookCallback = async (_input, toolUseId, context) => {
    // Release lock after git operation
    if (context.gitLockAcquired) {
      gitLock.release();
      context.gitLockAcquired = false;

      emitter?.emit('git:released', { toolUseId });
    }

    return {};
  };

  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [preHook],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Bash',
        hooks: [postHook],
      },
    ],
  };
}

/**
 * Create hooks for audit logging
 */
export function createAuditHooks(emitter: EventEmitter): HooksConfig {
  const preHook: HookCallback = async (input, toolUseId, _context) => {
    emitter.emit('audit:tool-start', {
      timestamp: new Date().toISOString(),
      toolUseId,
      tool: input.tool_name,
      input: input.tool_input,
    });

    return {};
  };

  const postHook: HookCallback = async (input, toolUseId, _context) => {
    emitter.emit('audit:tool-end', {
      timestamp: new Date().toISOString(),
      toolUseId,
      tool: input.tool_name,
    });

    return {};
  };

  return {
    PreToolUse: [
      {
        matcher: '.*',
        hooks: [preHook],
      },
    ],
    PostToolUse: [
      {
        matcher: '.*',
        hooks: [postHook],
      },
    ],
  };
}

/**
 * Create hooks for file modification tracking
 */
export function createFileTrackingHooks(emitter: EventEmitter): HooksConfig {
  const postHook: HookCallback = async (input, toolUseId, _context) => {
    const filePath = input.tool_input?.file_path as string;

    if (filePath) {
      emitter.emit('file:modified', {
        timestamp: new Date().toISOString(),
        toolUseId,
        tool: input.tool_name,
        filePath,
      });
    }

    return {};
  };

  return {
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [postHook],
      },
    ],
  };
}

/**
 * Create hooks for dangerous command blocking
 */
export function createSafetyHooks(blockedPatterns?: string[]): HooksConfig {
  const defaultBlocked = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf *',
    ':(){:|:&};:', // fork bomb
    'dd if=/dev/zero',
    'mkfs.',
    '> /dev/sda',
    'chmod -R 777 /',
    'git push.*--force.*main',
    'git push.*--force.*master',
  ];

  const patterns = blockedPatterns || defaultBlocked;

  const preHook: HookCallback = async (input, _toolUseId, _context) => {
    const command = (input.tool_input?.command as string) || '';

    for (const pattern of patterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(command)) {
        return {
          block: `Blocked dangerous command matching pattern: ${pattern}`,
        };
      }
    }

    return {};
  };

  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [preHook],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// Hook Composition
// ─────────────────────────────────────────────────────────────

/**
 * Merge multiple hook configurations
 */
export function mergeHooks(...configs: HooksConfig[]): HooksConfig {
  const merged: HooksConfig = {
    PreToolUse: [],
    PostToolUse: [],
  };

  for (const config of configs) {
    if (config.PreToolUse) {
      merged.PreToolUse!.push(...config.PreToolUse);
    }
    if (config.PostToolUse) {
      merged.PostToolUse!.push(...config.PostToolUse);
    }
  }

  return merged;
}

/**
 * Create the default hook configuration for the orchestrator
 */
export function createDefaultHooks(emitter: EventEmitter): HooksConfig {
  return mergeHooks(
    createGitSafetyHooks(emitter),
    createAuditHooks(emitter),
    createFileTrackingHooks(emitter),
    createSafetyHooks()
  );
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Check if a command is a git command
 */
function isGitCommand(command: string): boolean {
  const gitPatterns = [
    /^git\s/,
    /^\s*git\s/,
    /&&\s*git\s/,
    /;\s*git\s/,
    /\|\s*git\s/,
  ];

  return gitPatterns.some((pattern) => pattern.test(command));
}

/**
 * Export the global git lock for external use
 */
export { gitLock };
