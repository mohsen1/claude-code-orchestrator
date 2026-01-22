/**
 * Crash Logger - Synchronous crash logging that bypasses buffered loggers
 *
 * This module provides a crash logger that writes directly to a file descriptor
 * using fs.writeSync, ensuring that critical errors are captured even if the
 * process crashes abnormally (OOM, segfault, etc.).
 *
 * This is especially important because winston's file transports buffer writes,
 * and if the Node process is killed (e.g., by OOM killer), those buffers may
 * not be flushed to disk.
 */

import { writeSync, openSync, closeSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

let crashLogFile: number | null = null;
let crashLogPath: string | null = null;

/**
 * Initialize the crash logger with a log directory
 */
export function initCrashLogger(logDir: string): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  crashLogPath = join(logDir, 'crash.log');

  try {
    // Open file in append mode with sync writes
    crashLogFile = openSync(crashLogPath, 'a');
    writeSync(crashLogFile, `\n${'='.repeat(80)}\n`);
    writeSync(crashLogFile, `CRASH LOG INITIALIZED: ${new Date().toISOString()}\n`);
    writeSync(crashLogFile, `${'='.repeat(80)}\n`);
  } catch (err) {
    // If we can't open crash log, at least write to stderr
    console.error('[CRASH LOGGER] Failed to initialize crash log:', err);
  }
}

/**
 * Write a crash log entry synchronously
 * This will complete even if the process is about to crash
 */
export function logCrash(message: string, metadata?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;

  // Always write to stderr (will appear in terminal)
  console.error(logEntry);

  // Also write to crash log file if available
  if (crashLogFile !== null) {
    try {
      writeSync(crashLogFile, logEntry);
      if (metadata && Object.keys(metadata).length > 0) {
        writeSync(crashLogFile, `  Metadata: ${JSON.stringify(metadata)}\n`);
      }
    } catch (err) {
      // If write fails, try stderr
      console.error('[CRASH LOGGER] Failed to write to crash log:', err);
    }
  }
}

/**
 * Log an uncaught exception
 */
export function logUncaughtException(error: Error): void {
  logCrash('UNCAUGHT EXCEPTION DETECTED', {
    message: error.message,
    stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    name: error.name,
  });
}

/**
 * Log an unhandled rejection
 */
export function logUnhandledRejection(reason: unknown): void {
  logCrash('UNHANDLED REJECTION DETECTED', {
    reason: String(reason),
    type: typeof reason,
  });
}

/**
 * Log system state (memory, etc.)
 */
export function logSystemState(): void {
  const memUsage = process.memoryUsage();
  logCrash('SYSTEM STATE', {
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
    external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
    arrayBuffers: `${Math.round(memUsage.arrayBuffers / 1024 / 1024)}MB`,
    pid: process.pid,
    uptime: `${Math.round(process.uptime())}s`,
  });
}

/**
 * Close the crash log file gracefully
 */
export function closeCrashLogger(): void {
  if (crashLogFile !== null) {
    try {
      writeSync(crashLogFile, `\n${'='.repeat(80)}\n`);
      writeSync(crashLogFile, `CRASH LOG CLOSED: ${new Date().toISOString()}\n`);
      writeSync(crashLogFile, `${'='.repeat(80)}\n\n`);
      closeSync(crashLogFile);
    } catch (err) {
      console.error('[CRASH LOGGER] Failed to close crash log:', err);
    }
    crashLogFile = null;
  }
}

/**
 * Get the crash log path
 */
export function getCrashLogPath(): string | null {
  return crashLogPath;
}

/**
 * Setup global error handlers with crash logging
 */
export function setupCrashHandlers(): void {
  // Log uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    logUncaughtException(error);
    logSystemState();

    // Give sync writes a moment to complete
    setTimeout(() => {
      process.exit(1);
    }, 100);
  });

  // Log unhandled rejections
  process.on('unhandledRejection', (reason: unknown) => {
    logUnhandledRejection(reason);
    logSystemState();

    // Don't exit for rejections, just log them
    // But if it's a fatal error, exit after a delay
    if (reason instanceof Error && reason.message.includes('EMFILE')) {
      setTimeout(() => {
        process.exit(1);
      }, 100);
    }
  });

  // Log before exit
  process.on('exit', (code) => {
    if (code !== 0) {
      logCrash(`PROCESS EXITING WITH CODE ${code}`);
      logSystemState();
    }
    closeCrashLogger();
  });

  // Log termination signals
  process.on('SIGINT', () => {
    logCrash('Received SIGINT (Ctrl+C)');
    closeCrashLogger();
  });

  process.on('SIGTERM', () => {
    logCrash('Received SIGTERM');
    logSystemState();
    closeCrashLogger();
  });

  // Log OOM-like conditions (high heap usage)
  if (process.env.ENABLE_OOM_DETECTION === 'true') {
    setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
      const heapTotalMB = memUsage.heapTotal / 1024 / 1024;

      // Warn if heap usage is > 90% of total
      if (heapUsedMB / heapTotalMB > 0.9) {
        logCrash('HIGH HEAP USAGE WARNING', {
          heapUsed: `${Math.round(heapUsedMB)}MB`,
          heapTotal: `${Math.round(heapTotalMB)}MB`,
          percentUsed: `${Math.round((heapUsedMB / heapTotalMB) * 100)}%`,
        });
      }
    }, 30000); // Check every 30 seconds
  }
}
