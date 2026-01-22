import winston from 'winston';
import type TransportStream from 'winston-transport';
import { mkdirSync } from 'fs';
import { join } from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Use simple ISO timestamp to avoid fecha library recursion issues under high load
const simpleTimestamp = winston.format((info) => {
  info.timestamp = new Date().toISOString();
  return info;
});

const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  if (Object.keys(metadata).length > 0 && metadata.stack === undefined) {
    // Truncate large metadata to prevent memory issues
    const metaStr = JSON.stringify(metadata);
    msg += ` ${metaStr.length > 1000 ? metaStr.slice(0, 1000) + '...' : metaStr}`;
  }

  if (metadata.stack) {
    msg += `\n${metadata.stack}`;
  }

  return msg;
});

const consoleTransport = new winston.transports.Console({
  format: combine(
    colorize(),
    simpleTimestamp(),
    logFormat
  ),
});

const DEFAULT_LOG_DIR = 'logs';

const createFileTransports = (dir: string): TransportStream[] => {
  mkdirSync(dir, { recursive: true });
  return [
    new winston.transports.File({
      filename: join(dir, 'error.log'),
      level: 'error',
      maxsize: 1048576, // 1MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: join(dir, 'combined.log'),
      maxsize: 1048576, // 1MB
      maxFiles: 3,
    }),
  ];
};

let currentLogDir = DEFAULT_LOG_DIR;
let fileTransports = createFileTransports(DEFAULT_LOG_DIR);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    simpleTimestamp(),
    logFormat
  ),
  transports: [consoleTransport, ...fileTransports],
});

export function configureLogDirectory(dir: string): void {
  if (!dir || dir === currentLogDir) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  const newTransports = createFileTransports(dir);

  for (const transport of fileTransports) {
    logger.remove(transport);
    if (typeof (transport as { close?: () => void }).close === 'function') {
      (transport as { close: () => void }).close();
    }
  }

  for (const transport of newTransports) {
    logger.add(transport);
  }

  fileTransports = newTransports;
  currentLogDir = dir;
}

// ─────────────────────────────────────────────────────────────
// Throttled Logger for High-Frequency Events
// ─────────────────────────────────────────────────────────────

interface ThrottledLogState {
  lastLogTime: number;
  pendingCount: number;
  pendingData: Map<string, number>; // sessionId -> count
}

const throttledStates: Map<string, ThrottledLogState> = new Map();

/**
 * Create a throttled logger that batches high-frequency events.
 * Logs immediately on first call, then batches subsequent calls
 * and logs a summary every `intervalMs` milliseconds.
 */
export function createThrottledLogger(
  eventName: string,
  intervalMs: number = 5000
): (message: string, metadata?: Record<string, unknown>) => void {
  const state: ThrottledLogState = {
    lastLogTime: 0,
    pendingCount: 0,
    pendingData: new Map(),
  };
  throttledStates.set(eventName, state);

  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (state.pendingCount > 0) {
      const sessionSummary = Array.from(state.pendingData.entries())
        .map(([sid, count]) => `${sid}:${count}`)
        .join(', ');
      logger.info(`${eventName} (batched)`, {
        totalCount: state.pendingCount,
        sessions: sessionSummary,
      });
      state.pendingCount = 0;
      state.pendingData.clear();
    }
    flushTimer = null;
  };

  return (message: string, metadata?: Record<string, unknown>) => {
    const now = Date.now();
    const sessionId = (metadata?.sessionId as string) || 'unknown';

    // Always log immediately if enough time has passed
    if (now - state.lastLogTime >= intervalMs) {
      // Flush any pending counts first
      if (state.pendingCount > 0) {
        flush();
      }
      logger.info(message, metadata);
      state.lastLogTime = now;
      return;
    }

    // Otherwise batch it
    state.pendingCount++;
    state.pendingData.set(sessionId, (state.pendingData.get(sessionId) || 0) + 1);

    // Schedule a flush if not already scheduled
    if (!flushTimer) {
      flushTimer = setTimeout(flush, intervalMs);
    }
  };
}

/**
 * Create a sampled logger that only logs every Nth event.
 * Useful for very high frequency events like streaming text.
 */
export function createSampledLogger(
  sampleRate: number = 100
): (level: 'debug' | 'info', message: string, metadata?: Record<string, unknown>) => void {
  let count = 0;

  return (level: 'debug' | 'info', message: string, metadata?: Record<string, unknown>) => {
    count++;
    if (count % sampleRate === 0) {
      logger[level](`${message} (sample ${count})`, metadata);
    }
  };
}

/**
 * Flush all pending throttled logs (call on shutdown)
 */
export function flushThrottledLogs(): void {
  for (const [eventName, state] of throttledStates) {
    if (state.pendingCount > 0) {
      const sessionSummary = Array.from(state.pendingData.entries())
        .map(([sid, count]) => `${sid}:${count}`)
        .join(', ');
      logger.info(`${eventName} (final flush)`, {
        totalCount: state.pendingCount,
        sessions: sessionSummary,
      });
      state.pendingCount = 0;
      state.pendingData.clear();
    }
  }
}

export default logger;
