import express, { Request, Response, NextFunction } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';

export interface HookPayload {
  hook_name: string;
  instance_id: string;
  worker_id: number;
  instance_type: 'director' | 'em' | 'worker' | 'manager';
  data: Record<string, unknown>;
}

type HookHandler = (payload: HookPayload) => Promise<void>;

interface HookServerOptions {
}

export class HookServer {
  private app: express.Application;
  private handlers: Map<string, HookHandler[]> = new Map();
  private server: ReturnType<typeof this.app.listen> | null = null;

  constructor(private port: number = 3000, _options: HookServerOptions = {}) {
    this.app = express();
    this.app.use(express.json());
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug(`${req.method} ${req.path}`, { body: req.body });
      next();
    });

    // Error handling
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('Server error', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
    // Main hook endpoint
    this.app.post('/hooks/:hookName', async (req: Request, res: Response) => {
      const hookNameParam = req.params.hookName;
      const hookName = Array.isArray(hookNameParam) ? hookNameParam[0] : hookNameParam;

      const workerId = Array.isArray(req.body.worker_id)
        ? req.body.worker_id[0]
        : req.body.worker_id;

      const payload: HookPayload = {
        hook_name: String(hookName),
        instance_id: String(req.body.instance_id || ''),
        worker_id: parseInt(String(workerId), 10) || 0,
        instance_type: (req.body.instance_type || 'worker') as HookPayload['instance_type'],
        data: req.body.data || {},
      };

      logger.info(`Received hook: ${hookName}`, {
        instanceId: payload.instance_id,
        type: payload.instance_type,
      });

      // Execute handlers
      const handlers = this.handlers.get(String(hookName)) || [];
      for (const handler of handlers) {
        try {
          await handler(payload);
        } catch (err) {
          logger.error(`Hook handler error: ${hookName}`, err);
        }
      }

      res.json({ status: 'ok', hook: hookName });
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // Status endpoint - returns orchestrator status
    this.app.get('/status', (_req: Request, res: Response) => {
      res.json({
        status: 'running',
        uptime: process.uptime(),
        handlers: Array.from(this.handlers.keys()),
      });
    });
  }

  /**
   * Register a handler for a specific hook.
   */
  on(hookName: string, handler: HookHandler): void {
    const handlers = this.handlers.get(hookName) || [];
    handlers.push(handler);
    this.handlers.set(hookName, handlers);
    logger.debug(`Registered handler for hook: ${hookName}`);
  }

  /**
   * Remove all handlers for a hook.
   */
  off(hookName: string): void {
    this.handlers.delete(hookName);
  }

  /**
   * Start the server.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(`Hook server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            logger.warn('Error stopping hook server', err);
          }
          this.server = null;
          logger.info('Hook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the port the server is listening on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the express app instance (for testing).
   */
  getApp(): express.Application {
    return this.app;
  }
}
