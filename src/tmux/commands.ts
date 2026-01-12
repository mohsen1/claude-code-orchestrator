import { TmuxManager } from './session.js';

/**
 * Higher-level tmux commands for Claude Code interaction.
 */
export class TmuxCommands {
  constructor(private tmux: TmuxManager) {}

  /**
   * Send a prompt to Claude Code.
   */
  async sendClaudePrompt(sessionName: string, prompt: string): Promise<void> {
    // Escape single quotes for shell
    const escaped = prompt.replace(/'/g, "'\\''");
    await this.tmux.sendKeys(sessionName, escaped);
  }

  /**
   * Interrupt current Claude operation (Ctrl+C).
   */
  async interruptClaude(sessionName: string): Promise<void> {
    await this.tmux.sendControlKey(sessionName, 'C-c');
  }

  /**
   * Send Escape key (exit from prompts, etc).
   */
  async sendEscape(sessionName: string): Promise<void> {
    await this.tmux.sendControlKey(sessionName, 'Escape');
  }

  /**
   * Send Enter key.
   */
  async sendEnter(sessionName: string): Promise<void> {
    await this.tmux.sendKeys(sessionName, '', true);
  }

  /**
   * Enter tmux scroll mode to view history.
   */
  async enterScrollMode(sessionName: string): Promise<void> {
    await this.tmux.sendControlKey(sessionName, 'C-b');
    await this.tmux.sendControlKey(sessionName, '[');
  }

  /**
   * Exit tmux scroll mode.
   */
  async exitScrollMode(sessionName: string): Promise<void> {
    await this.tmux.sendControlKey(sessionName, 'q');
  }

  /**
   * Wait for a specific pattern in the output.
   * WARNING: Use sparingly - prefer hooks for control flow.
   */
  async waitForPattern(
    sessionName: string,
    pattern: RegExp,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 1000
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const output = await this.tmux.capturePane(sessionName, 50);

      if (pattern.test(output)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }
}
