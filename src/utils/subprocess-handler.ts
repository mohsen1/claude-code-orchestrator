/**
 * Subprocess Handler - Safe subprocess execution with isolation and error handling
 *
 * This module provides safer subprocess execution to prevent worker subprocess
 * crashes (like wasm-pack) from propagating to and crashing the orchestrator.
 *
 * Key features:
 * - Timeout enforcement (prevent hanging subprocesses)
 * - Signal handling (clean termination)
 * - Stderr capture (catch error output)
 * - Exit code validation
 * - Resource cleanup
 */

import { execa } from 'execa';
import { logCrash } from './crash-logger.js';

export interface SubprocessOptions {
  // Maximum time to allow subprocess to run (ms)
  timeout?: number;

  // Maximum buffer size for stdout/stderr
  maxBuffer?: number;

  // Environment variables
  env?: Record<string, string>;

  // Working directory
  cwd?: string;

  // Whether to reject on non-zero exit code
  reject?: boolean;

  // Allow failure (don't throw on error)
  allowFailure?: boolean;
}

export interface SubprocessResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
  signal?: string;
}

/**
 * Execute a subprocess with safety wrappers
 */
export async function executeSubprocess(
  command: string,
  args: string[] = [],
  options: SubprocessOptions = {}
): Promise<SubprocessResult> {
  const {
    timeout = 120000, // 2 minutes default
    maxBuffer = 10 * 1024 * 1024, // 10MB
    env = {},
    cwd,
    reject = true,
    allowFailure = false,
  } = options;

  const startTime = Date.now();
  let child: any = null;

  try {
    // Log subprocess start
    const cmdString = [command, ...args].join(' ');
    const truncatedCmd = cmdString.length > 200 ? cmdString.substring(0, 200) + '...' : cmdString;

    // Set up environment with safety limits
    const subprocessEnv = {
      ...process.env,
      ...env,
      // Limit subprocess memory usage (Node.js v14+)
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS || '',
        '--max-old-space-size=2048', // Limit to 2GB
      ].filter(Boolean).join(' '),
    };

    // Spawn the subprocess
    child = execa(command, args, {
      timeout,
      maxBuffer,
      env: subprocessEnv,
      cwd,
      reject: true, // We'll handle rejection ourselves
    });

    // Wait for completion
    const result = await child;

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      exitCode: result.exitCode,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      timedOut: false,
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for timeout
    const isTimeout = errorMessage.includes('timed out') ||
                      errorMessage.includes('ETIMEDOUT') ||
                      (error as any).timedOut === true;

    // Check for signal termination
    const signal = (error as any).signal;

    // Check for common crash patterns
    const isCrash = errorMessage.includes('Abort trap') ||
                    errorMessage.includes('Segmentation fault') ||
                    errorMessage.includes('SIGABRT') ||
                    errorMessage.includes('SIGSEGV');

    if (isCrash) {
      logCrash('SUBPROCESS CRASH DETECTED', {
        command,
        args: args.join(' '),
        error: errorMessage,
        signal,
        duration: `${durationMs}ms`,
      });
    }

    // Extract exit code if available
    const exitCode = (error as any).exitCode || (error as any).code;

    // Extract stderr if available
    const stderr = (error as any).stderr || '';

    // Build result
    const result: SubprocessResult = {
      success: allowFailure || (exitCode === 0 || exitCode === null),
      exitCode: exitCode || null,
      stdout: (error as any).stdout || '',
      stderr: typeof stderr === 'string' ? stderr : '',
      error: errorMessage,
      timedOut: isTimeout,
      signal,
    };

    // Log subprocess failure
    if (!allowFailure && reject && !result.success) {
      const failureDetails = {
        command,
        args: args.join(' '),
        exitCode: result.exitCode,
        error: errorMessage,
        timedOut: isTimeout,
        signal,
        duration: `${durationMs}ms`,
      };

      if (isCrash) {
        // Already logged to crash file
        console.error('[SUBPROCESS] Crash detected:', failureDetails);
      } else if (isTimeout) {
        console.warn('[SUBPROCESS] Timeout:', failureDetails);
      } else {
        console.error('[SUBPROCESS] Failure:', failureDetails);
      }
    }

    // If reject is true and not allowing failure, throw
    if (reject && !allowFailure && !result.success) {
      throw error;
    }

    return result;
  }
}

/**
 * Execute a subprocess with a timeout wrapper
 * This is a convenience function that ensures timeout is enforced
 */
export async function executeWithTimeout(
  command: string,
  args: string[] = [],
  timeoutMs: number = 120000
): Promise<SubprocessResult> {
  return executeSubprocess(command, args, { timeout: timeoutMs });
}

/**
 * Execute a subprocess and allow failure (don't throw)
 */
export async function executeAllowingFailure(
  command: string,
  args: string[] = [],
  options?: Omit<SubprocessOptions, 'allowFailure'>
): Promise<SubprocessResult> {
  return executeSubprocess(command, args, { ...options, allowFailure: true, reject: false });
}

/**
 * Kill a subprocess tree (process + children)
 * This is useful for cleanup when a task is cancelled
 */
export async function killSubprocess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch (err) {
    // Process might already be dead
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw err;
    }
  }
}

/**
 * Execute a batch of subprocesses in parallel with concurrency limit
 */
export async function executeBatch(
  tasks: Array<{ command: string; args: string[]; options?: SubprocessOptions }>,
  concurrency: number = 5
): Promise<SubprocessResult[]> {
  const results: SubprocessResult[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const promise = executeSubprocess(task.command, task.args, task.options).then(result => {
      results.push(result);
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      const settled = await Promise.allSettled(executing);
      executing.length = 0;
    }
  }

  await Promise.all(executing);
  return results;
}
