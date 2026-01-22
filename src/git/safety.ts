import { execa } from 'execa';
import { readdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { getGitQueue } from './operation-queue.js';
import { executeSubprocess } from '../utils/subprocess-handler.js';

const DEFAULT_TIMEOUT_MS = 240000; // 4 minutes - increased for parallel worker operations
const STALE_LOCK_MS = 2 * 60 * 1000;

// Exponential backoff for git failures
let gitFailureCount = 0;
const GIT_FAILURE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_LOCK_SCAN_DEPTH = 4;

// Stack overflow prevention
let totalFailureCount = 0;
const MAX_TOTAL_FAILURES = 50; // Prevent infinite retry loops
const FAILURE_RESET_INTERVAL = 60000; // Reset counter after 60 seconds of success

export interface GitRunOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  retryOnLock?: boolean;
  /** Skip the queue and run immediately (use sparingly) */
  skipQueue?: boolean;
  /** Priority for queued operations */
  priority?: 'high' | 'normal' | 'low';
  /** Use global lock (for fetch, push, gc - operations that affect the whole repo) */
  isGlobal?: boolean;
}

type GitRunResult = Awaited<ReturnType<typeof execa>>;

export async function getGitDir(workDir: string): Promise<string | null> {
  try {
    const result = await executeSubprocess('git', ['-C', workDir, 'rev-parse', '--absolute-git-dir'], {
      timeout: DEFAULT_TIMEOUT_MS,
      env: { ...process.env, GIT_PAGER: 'cat' },
      allowFailure: true,
      reject: false,
    });
    if (!result.success || result.exitCode !== 0) {
      return null;
    }
    const gitDir = result.stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch (err) {
    logger.debug('Failed to resolve git dir', { workDir, err });
    return null;
  }
}

async function listLockFiles(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    let entries: Array<import('fs').Dirent<string>>;
    try {
      entries = await readdir(current.dir, { withFileTypes: true, encoding: 'utf8' }) as Array<import('fs').Dirent<string>>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith('.lock')) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isLockRelatedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('index.lock') ||
    message.includes('could not write index') ||
    message.includes('Another git process') ||
    message.includes('Unable to create') ||
    message.includes('File exists')
  );
}

export async function clearStaleGitLocks(workDir: string, staleMs: number = STALE_LOCK_MS): Promise<string[]> {
  const gitDir = await getGitDir(workDir);
  if (!gitDir || !existsSync(gitDir)) {
    return [];
  }

  const now = Date.now();
  const lockFiles = await listLockFiles(gitDir, MAX_LOCK_SCAN_DEPTH);
  const removed: string[] = [];

  for (const lockFile of lockFiles) {
    try {
      const fileStat = await stat(lockFile);
      if (now - fileStat.mtimeMs < staleMs) {
        continue;
      }
      await rm(lockFile, { force: true });
      removed.push(lockFile);
    } catch {
      continue;
    }
  }

  if (removed.length > 0) {
    logger.warn(`Cleared ${removed.length} stale git lock file(s)`, { workDir, removed });
  }

  return removed;
}

/**
 * Internal implementation that actually runs the git command.
 * This is called either directly (skipQueue) or via the queue.
 */
async function runGitImmediate(
  workDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, GIT_PAGER: 'cat', ...options.env };
  const retryOnLock = options.retryOnLock ?? true;

  await clearStaleGitLocks(workDir);

  const attempt = async () => {
    // Use subprocess handler for better isolation and crash detection
    const result = await executeSubprocess('git', ['-C', workDir, ...args], {
      timeout: timeoutMs,
      env,
      allowFailure: options.allowFailure ?? false,
      reject: false, // We'll handle rejection ourselves
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    // Convert to execa-like result format
    if (result.success) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
        failed: false,
        isCancelled: false,
        killed: false,
      } as unknown as GitRunResult;
    } else {
      // Throw in the expected format
      const error = new Error(result.error || `Git command failed with exit code ${result.exitCode}`);
      (error as any).exitCode = result.exitCode;
      (error as any).stdout = result.stdout;
      (error as any).stderr = result.stderr;
      (error as any).timedOut = result.timedOut;
      (error as any).signal = result.signal;
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    const timedOut = typeof err === 'object' && err !== null && 'timedOut' in err && Boolean((err as { timedOut?: boolean }).timedOut);
    if (retryOnLock && (timedOut || isLockRelatedError(err))) {
      logger.warn('Git command failed, attempting lock cleanup and retry', {
        workDir,
        args: args.join(' '),
      });
      await clearStaleGitLocks(workDir);
      return await attempt();
    }
    throw err;
  }
}

/**
 * Run a git command, serialized through the operation queue to prevent lock contention.
 *
 * With 14+ workers using worktrees, concurrent git operations can fail due to
 * .git/index.lock conflicts. This function queues operations to run serially.
 *
 * With bucketed locking:
 * - Local operations (add, commit, status, diff) run in parallel per workdir
 * - Global operations (fetch, push, gc) use a global lock
 *
 * Use `skipQueue: true` only for read-only commands that don't touch the index.
 */
export async function runGit(
  workDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  // Some commands are safe to run concurrently (read-only)
  const safeCommands = ['rev-parse', 'branch', '--show-current', 'log', 'diff', 'show', 'ls-tree', 'cat-file'];
  const isSafeCommand = safeCommands.some(cmd => args.includes(cmd)) && !args.includes('checkout');

  // Auto-detect global operations (fetch, push, gc, remote, worktree operations)
  const globalCommands = ['fetch', 'push', 'gc', 'remote', 'worktree'];
  const isGlobalOperation = options.isGlobal ?? globalCommands.some(cmd => args.includes(cmd));

  // Auto-detect critical operations that should have higher priority
  const criticalCommands = ['merge', 'push', 'commit', 'rebase'];
  const isCritical = criticalCommands.some(cmd => args.includes(cmd));

  if (options.skipQueue || isSafeCommand) {
    return runGitImmediateWithBackoff(workDir, args, options);
  }

  const queue = getGitQueue();
  return queue.enqueue(
    workDir,
    () => runGitImmediateWithBackoff(workDir, args, options),
    {
      isGlobal: isGlobalOperation,
      // Critical operations (merge, push, commit) get higher priority
      priority: isCritical ? 'high' : (options.priority ?? 'normal'),
      label: args.slice(0, 3).join(' '),
    }
  );
}

/**
 * Wrapper around runGitImmediate that adds exponential backoff for failures
 * and prevents stack overflow through global failure counting
 */
async function runGitImmediateWithBackoff(
  workDir: string,
  args: string[],
  options: GitRunOptions = {}
): Promise<GitRunResult> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  // Stack overflow prevention: check global failure count
  if (totalFailureCount >= MAX_TOTAL_FAILURES) {
    const errorMsg = `Git operations failing too frequently (${totalFailureCount} failures). Aborting to prevent stack overflow. Command: ${args.slice(0, 3).join(' ')}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runGitImmediate(workDir, args, options);
      // Reset failure counts on success
      gitFailureCount = 0;
      // Slowly decay total failure count on success (don't reset to 0 immediately)
      if (totalFailureCount > 0) {
        totalFailureCount = Math.max(0, totalFailureCount - 2);
      }
      return result;
    } catch (err: unknown) {
      lastError = err as Error;
      gitFailureCount++;
      totalFailureCount++;

      // Check if this is a retryable error (timeout, lock, or network issue)
      const errorObj = err as { timedOut?: boolean; message?: string; stderr?: string };
      const errorMessage = errorObj.message || String(err);
      const stderrMessage = errorObj.stderr || '';
      const fullError = errorMessage + ' ' + stderrMessage;

      const isRetryable = errorObj.timedOut ||
        isLockRelatedError(err) ||
        fullError.includes('timed out') ||
        fullError.includes('timeout') ||
        fullError.includes('Connection reset') ||
        fullError.includes('unable to access');

      // Check for uncommitted changes blocking operations
      if (fullError.includes('would be overwritten') ||
          fullError.includes('unmerged files') ||
          fullError.includes('unresolved conflict')) {
        // Not retryable - requires human intervention or reset
        logger.error(`Git operation blocked by uncommitted changes or conflicts`, {
          command: args.slice(0, 3).join(' '),
          error: fullError.slice(0, 300),
        });

        // Get details about what's blocking
        const uncommittedFiles = await getUncommittedFiles(workDir);
        if (uncommittedFiles.length > 0) {
          logger.error('Uncommitted files detected', {
            files: uncommittedFiles.slice(0, 10),
            totalFiles: uncommittedFiles.length,
          });
        }

        throw new Error(`Git operation blocked: ${fullError.slice(0, 200)}`);
      }

      if (!isRetryable || attempt >= maxRetries) {
        break;
      }

      // Exponential backoff with jitter
      const backoffMs = Math.min(
        GIT_FAILURE_BACKOFF_MS * Math.pow(2, attempt),
        MAX_BACKOFF_MS
      );
      const jitterMs = Math.random() * 500; // Add randomness to prevent thundering herd

      logger.warn(`Git operation failed, retrying with backoff`, {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        totalFailures: totalFailureCount,
        maxTotalFailures: MAX_TOTAL_FAILURES,
        backoffMs: Math.round(backoffMs + jitterMs),
        command: args.slice(0, 3).join(' '),
        error: fullError.slice(0, 200),
      });

      await sleep(backoffMs + jitterMs);
    }
  }

  throw lastError;
}

/**
 * Simple sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if git working directory is clean (no uncommitted changes)
 */
export async function isGitWorkDirClean(workDir: string): Promise<boolean> {
  try {
    const result = await executeSubprocess('git', ['-C', workDir, 'status', '--porcelain'], {
      timeout: 5000,
      env: { ...process.env, GIT_PAGER: 'cat' },
      allowFailure: true,
    });

    if (!result.success || result.exitCode !== 0) {
      return false;
    }

    // Check if there are any changes (added, modified, deleted, untracked)
    const hasChanges = (result.stdout || '').trim().length > 0;
    return !hasChanges;
  } catch {
    return false;
  }
}

/**
 * Get uncommitted file paths (for debugging/error messages)
 */
export async function getUncommittedFiles(workDir: string): Promise<string[]> {
  try {
    const result = await executeSubprocess('git', ['-C', workDir, 'status', '--porcelain'], {
      timeout: 5000,
      env: { ...process.env, GIT_PAGER: 'cat' },
      allowFailure: true,
    });

    if (!result.success) {
      return [];
    }

    const stdout = result.stdout || '';
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => {
        // Git status --porcelain format: XY filename
        // X = staged, Y = unstaged
        const status = line.substring(0, 2);
        const filename = line.substring(3);
        return `${status}:${filename}`;
      });
  } catch {
    return [];
  }
}
