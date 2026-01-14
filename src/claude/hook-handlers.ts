import { HookPayload, HookServer } from '../server.js';
import { ClaudeInstanceManager } from './instance.js';
import { logger } from '../utils/logger.js';

export interface HookHandlerCallbacks {
  onTaskComplete: (workerId: number, instanceType: 'director' | 'em' | 'worker' | 'manager') => void;
  onError: (instanceId: string, error: unknown) => void;
  onRateLimit: (instanceId: string) => void;
}

/**
 * Register standard hook handlers for Claude Code events.
 */
export function registerHookHandlers(
  server: HookServer,
  instanceManager: ClaudeInstanceManager,
  callbacks: HookHandlerCallbacks
): void {
  // Stop hook - instance finished its task
  server.on('stop', async (payload: HookPayload) => {
    logger.info(`Instance ${payload.instance_id} stopped`, {
      type: payload.instance_type,
      workerId: payload.worker_id,
    });

    const instance = instanceManager.getInstance(payload.instance_id);
    if (instance) {
      instance.status = 'idle';
      instanceManager.clearTask(payload.instance_id);
    }

    callbacks.onTaskComplete(payload.worker_id, payload.instance_type);
  });

  // Error hook - instance encountered an error
  server.on('error', async (payload: HookPayload) => {
    logger.error(`Instance ${payload.instance_id} error`, payload.data);

    const instance = instanceManager.getInstance(payload.instance_id);
    if (instance) {
      instance.status = 'error';
    }

    callbacks.onError(payload.instance_id, payload.data);
  });

  // Rate limit hook - need to rotate config
  server.on('rate_limit', async (payload: HookPayload) => {
    logger.warn(`Instance ${payload.instance_id} hit rate limit`);
    callbacks.onRateLimit(payload.instance_id);
  });

  // ToolUse hook - heartbeat/activity tracking
  server.on('tool_use', async (payload: HookPayload) => {
    instanceManager.updateToolUse(payload.instance_id);
    logger.debug(`Instance ${payload.instance_id} tool use`);
  });

  // Container ready hook - container has started
  server.on('container_ready', async (payload: HookPayload) => {
    logger.info(`Container ready: ${payload.instance_id}`, {
      type: payload.instance_type,
      workerId: payload.worker_id,
    });
  });

  logger.info('Registered hook handlers: stop, error, rate_limit, tool_use, container_ready');
}
