/**
 * TmuxClaudeRunner - Runs Claude Code CLI interactively in tmux sessions
 * 
 * Key insight: Claude Code CLI's `-p` (print) mode doesn't modify files.
 * To get file modifications, we need to run Claude interactively.
 * 
 * This runner:
 * 1. Creates tmux sessions for each Claude instance
 * 2. Starts Claude Code CLI interactively with --dangerously-skip-permissions
 * 3. Sends prompts via tmux send-keys
 * 4. Waits for completion by polling output
 * 5. Captures results via tmux capture-pane
 * 
 * CRITICAL: Must wait 3+ seconds after send-keys before pressing Enter
 */

import { execa } from 'execa';
import { EventEmitter } from 'events';
// Simple logger for standalone use
const logger = {
  info: (msg: string, data?: object) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (msg: string, data?: object) => console.log(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: object) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: object) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
};

// Minimum delay after send-keys before pressing Enter (user requirement)
const SEND_KEYS_DELAY_MS = 3000;

// Polling interval for completion detection
const POLL_INTERVAL_MS = 2000;

// Maximum time to wait for Claude response
const MAX_WAIT_MS = 600000; // 10 minutes

// Pattern that indicates Claude is ready for input
// This may need adjustment based on actual Claude CLI prompt
const READY_PATTERNS = [
  /^> $/m,           // Standard prompt
  /^\$ $/m,          // Shell-like prompt
  /^claude> $/m,     // Named prompt
  /waiting for input/i,
];

// Pattern that indicates Claude is still processing
const PROCESSING_PATTERNS = [
  /thinking/i,
  /writing/i,
  /reading/i,
  /searching/i,
  /\.\.\.$/m,
];

export interface TmuxSession {
  name: string;
  workingDir: string;
  startedAt: Date;
  lastActivity: Date;
  isReady: boolean;
}

export interface RunResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export class TmuxClaudeRunner extends EventEmitter {
  private sessions: Map<string, TmuxSession> = new Map();
  private apiKey?: string;
  private baseUrl?: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  /**
   * Create a new tmux session with Claude running inside
   */
  async createSession(name: string, workingDir: string): Promise<TmuxSession> {
    logger.info('Creating tmux session', { name, workingDir });

    // Check if session already exists
    const exists = await this.sessionExists(name);
    if (exists) {
      logger.info('Session already exists, reusing', { name });
      const session = this.sessions.get(name);
      if (session) return session;
    }

    // Kill any existing session with same name (cleanup)
    await this.killSession(name).catch(() => {});

    // Create new tmux session
    await execa('tmux', [
      'new-session',
      '-d',           // detached
      '-s', name,     // session name
      '-c', workingDir // working directory
    ]);

    // Build environment for Claude
    const envCommands: string[] = [];
    if (this.apiKey) {
      envCommands.push(`export ANTHROPIC_API_KEY="${this.apiKey}"`);
      envCommands.push(`export ANTHROPIC_AUTH_TOKEN="${this.apiKey}"`);
    }
    if (this.baseUrl) {
      envCommands.push(`export ANTHROPIC_BASE_URL="${this.baseUrl}"`);
    }

    // Set environment variables in the tmux session
    for (const cmd of envCommands) {
      await this.sendKeysRaw(name, cmd);
      await this.sleep(500);
    }

    // Start Claude Code CLI in interactive mode
    const claudeCmd = 'claude --dangerously-skip-permissions';
    logger.info('Starting Claude CLI', { name, cmd: claudeCmd });
    
    await this.sendKeysRaw(name, claudeCmd);
    
    // Wait for Claude to initialize
    await this.sleep(5000);

    const session: TmuxSession = {
      name,
      workingDir,
      startedAt: new Date(),
      lastActivity: new Date(),
      isReady: true,
    };

    this.sessions.set(name, session);
    this.emit('session:created', { name, workingDir });

    return session;
  }

  /**
   * Send a prompt to Claude and wait for response
   */
  async runPrompt(sessionName: string, prompt: string): Promise<RunResult> {
    const session = this.sessions.get(sessionName);
    if (!session) {
      return {
        success: false,
        output: '',
        error: `Session ${sessionName} not found`,
        durationMs: 0,
      };
    }

    const startTime = Date.now();
    logger.info('Sending prompt to Claude', { 
      sessionName, 
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 100) 
    });

    try {
      // Capture output before sending prompt (to find where new output starts)
      const beforeOutput = await this.capturePane(sessionName);
      const beforeLines = beforeOutput.split('\n').length;

      // Send the prompt via tmux send-keys
      // CRITICAL: Must wait 3 seconds after sending keys
      await this.sendPrompt(sessionName, prompt);

      // Wait for Claude to process and respond
      const output = await this.waitForResponse(sessionName, beforeLines);

      session.lastActivity = new Date();
      const durationMs = Date.now() - startTime;

      logger.info('Claude response received', { 
        sessionName, 
        outputLength: output.length,
        durationMs 
      });

      return {
        success: true,
        output,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = (error as Error).message;
      
      logger.error('Claude prompt failed', { sessionName, error: errorMessage });

      return {
        success: false,
        output: '',
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Send prompt text via tmux send-keys
   * MUST wait 3 seconds after sending before pressing Enter
   */
  private async sendPrompt(sessionName: string, prompt: string): Promise<void> {
    // Escape special characters for tmux
    const escapedPrompt = this.escapeForTmux(prompt);

    // Send the prompt text (without Enter)
    await execa('tmux', ['send-keys', '-t', sessionName, escapedPrompt]);

    // CRITICAL: Wait 3 seconds before pressing Enter (user requirement)
    logger.debug('Waiting 3 seconds before Enter', { sessionName });
    await this.sleep(SEND_KEYS_DELAY_MS);

    // Now press Enter
    await execa('tmux', ['send-keys', '-t', sessionName, 'Enter']);
  }

  /**
   * Send raw command (for setup, not prompts)
   */
  private async sendKeysRaw(sessionName: string, text: string): Promise<void> {
    await execa('tmux', ['send-keys', '-t', sessionName, text, 'Enter']);
  }

  /**
   * Wait for Claude to finish responding
   */
  private async waitForResponse(sessionName: string, skipLines: number): Promise<string> {
    const startTime = Date.now();
    let lastOutput = '';
    let stableCount = 0;
    const stableThreshold = 3; // Output must be stable for 3 polls
    let hadOutput = false;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      await this.sleep(POLL_INTERVAL_MS);

      const currentOutput = await this.capturePane(sessionName);
      
      // Extract only new output (after skipLines)
      const lines = currentOutput.split('\n');
      const newOutput = lines.slice(skipLines).join('\n').trim();

      // Track if we've seen any output
      if (newOutput.length > 0) {
        hadOutput = true;
      }

      // Check if output is stable (Claude finished)
      // Only check stability if we've had some output
      if (hadOutput && newOutput === lastOutput && newOutput.length > 0) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          logger.debug('Output stable, Claude finished', { sessionName });
          return this.cleanOutput(newOutput);
        }
      } else {
        stableCount = 0;
        lastOutput = newOutput;
      }

      // Check for ready indicator (Claude's prompt showing it's waiting for input)
      if (hadOutput && this.isReadyForInput(currentOutput)) {
        logger.debug('Ready indicator detected', { sessionName });
        return this.cleanOutput(newOutput);
      }

      // Log progress
      if ((Date.now() - startTime) % 10000 < POLL_INTERVAL_MS) {
        logger.debug('Waiting for Claude...', { 
          sessionName, 
          elapsedMs: Date.now() - startTime,
          outputLength: newOutput.length,
          hadOutput 
        });
      }
    }

    // If we had output but timed out, return what we have
    if (hadOutput && lastOutput.length > 0) {
      logger.warn('Timeout but returning partial output', { sessionName, outputLength: lastOutput.length });
      return this.cleanOutput(lastOutput);
    }

    throw new Error(`Timeout waiting for Claude response after ${MAX_WAIT_MS}ms`);
  }

  /**
   * Check if Claude is ready for input
   */
  private isReadyForInput(output: string): boolean {
    // Check last few lines for ready pattern
    const lastLines = output.split('\n').slice(-5).join('\n');
    
    for (const pattern of READY_PATTERNS) {
      if (pattern.test(lastLines)) {
        return true;
      }
    }

    // Also check that it's NOT still processing
    for (const pattern of PROCESSING_PATTERNS) {
      if (pattern.test(lastLines)) {
        return false;
      }
    }

    return false;
  }

  /**
   * Capture tmux pane content
   */
  private async capturePane(sessionName: string): Promise<string> {
    const result = await execa('tmux', [
      'capture-pane',
      '-t', sessionName,
      '-p',           // print to stdout
      '-S', '-1000',  // start from 1000 lines back
    ]);
    return result.stdout;
  }

  /**
   * Clean output by removing Claude UI elements
   */
  private cleanOutput(output: string): string {
    // Remove common Claude CLI formatting
    return output
      .replace(/^> /gm, '')           // Remove prompt markers
      .replace(/^\$ /gm, '')          // Remove shell markers
      .replace(/^claude> /gm, '')     // Remove named prompts
      .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI colors
      .trim();
  }

  /**
   * Escape special characters for tmux send-keys
   */
  private escapeForTmux(text: string): string {
    // Tmux send-keys needs special handling for certain characters
    return text
      .replace(/\\/g, '\\\\')    // Escape backslashes
      .replace(/"/g, '\\"')      // Escape quotes
      .replace(/\$/g, '\\$')     // Escape dollar signs
      .replace(/`/g, '\\`')      // Escape backticks
      .replace(/\n/g, ' ')       // Replace newlines with spaces (multi-line prompts handled differently)
  }

  /**
   * Check if a tmux session exists
   */
  private async sessionExists(name: string): Promise<boolean> {
    try {
      await execa('tmux', ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill a tmux session
   */
  async killSession(name: string): Promise<void> {
    try {
      await execa('tmux', ['kill-session', '-t', name]);
      this.sessions.delete(name);
      this.emit('session:destroyed', { name });
      logger.info('Killed tmux session', { name });
    } catch {
      // Session might not exist
    }
  }

  /**
   * Kill all managed sessions
   */
  async killAllSessions(): Promise<void> {
    for (const name of this.sessions.keys()) {
      await this.killSession(name);
    }
  }

  /**
   * Get all active sessions
   */
  getSessions(): TmuxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create a TmuxClaudeRunner from environment
 */
export function createTmuxRunner(): TmuxClaudeRunner {
  return new TmuxClaudeRunner({
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });
}
