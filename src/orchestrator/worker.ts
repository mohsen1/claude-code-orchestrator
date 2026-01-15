import { ClaudeInstanceManager } from '../claude/instance.js';
import { GitManager } from '../git/worktree.js';
import { logger } from '../utils/logger.js';

export class WorkerController {
  constructor(
    private instanceManager: ClaudeInstanceManager,
    private _git: GitManager
  ) {}

  /**
   * Initialize a worker with their initial prompt.
   */
  async initializeWorker(workerId: number, totalWorkers: number): Promise<void> {
    const instanceId = `worker-${workerId}`;
    const branchName = `worker-${workerId}`;

    const prompt = `
You are **Worker ${workerId}** in a Claude Code Orchestrator system.

## Your Environment
- Working directory: /repo/worktrees/worker-${workerId}
- Your branch: \`${branchName}\`
- Total workers: ${totalWorkers}

## Your Workflow

### 1. Check Your Task List
Read your task file: \`WORKER_${workerId}_TASK_LIST.md\`

This file has three sections:
- **Current Task**: What you should work on now
- **Queue**: Tasks waiting after current one
- **Completed**: Finished tasks

### 2. Execute Your Current Task
- Focus on the task in the "Current Task" section
- Make incremental commits as you work
- Keep your code clean and well-documented

### 3. When Task is Complete
\`\`\`bash
git add -A
git commit -m "Complete: <brief description of what you did>"
git push origin ${branchName}
\`\`\`
Do not force push. If push is rejected, stop and report.

### 4. IMPORTANT: Stop After Pushing
After pushing your changes, **STOP and wait**. The Manager will:
1. Review and merge your work
2. Update your task list
3. Notify you to continue

Do NOT move to the next task yourself.

## Error Handling
If you encounter issues:
1. Document the problem in your commits
2. Push what you have
3. Stop - the Manager will reassign or help

## Start Now
1. Read \`WORKER_${workerId}_TASK_LIST.md\`
2. Begin working on your "Current Task"
3. Commit and push when done
4. Stop
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Worker ${workerId} initialized`);
  }

  /**
   * Notify a worker to continue after merge.
   */
  async notifyWorkerToContinue(workerId: number): Promise<void> {
    const instanceId = `worker-${workerId}`;

    const prompt = `
## Event: Your Work Has Been Merged

The Manager has merged your branch and updated your task list.

### Your Actions:
1. Pull the latest main branch:
   \`\`\`bash
   git fetch origin main
   git rebase origin/main
   \`\`\`

2. Read your updated task list:
   \`\`\`bash
   cat WORKER_${workerId}_TASK_LIST.md
   \`\`\`

3. If there's a new "Current Task", start working on it

4. If your task list shows you're done (no more tasks), just stop

### Remember:
- Commit and push when task is complete
- Stop after pushing
- Wait for merge confirmation before next task
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Notified worker ${workerId} to continue`);
  }

  /**
   * Send a specific task to a worker.
   */
  async assignSpecificTask(workerId: number, taskDescription: string): Promise<void> {
    const instanceId = `worker-${workerId}`;

    const prompt = `
## New Task Assignment

You have been assigned a specific task by the Manager:

---

${taskDescription}

---

### Instructions:
1. Complete this task
2. Commit your changes with a descriptive message
3. Push to your branch: \`git push origin worker-${workerId}\`
   Do not force push. If push is rejected, stop and report.
4. Stop and wait for the Manager to merge your work
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Assigned specific task to worker ${workerId}`);
  }

  /**
   * Interrupt and redirect a worker.
   */
  async interruptWorker(workerId: number, reason: string): Promise<void> {
    const instanceId = `worker-${workerId}`;
    const instance = this.instanceManager.getInstance(instanceId);

    if (!instance) {
      logger.warn(`Cannot interrupt worker ${workerId}: not found`);
      return;
    }

    // Send interrupt signal
    await this.instanceManager.interruptInstance(instanceId);

    // Wait a moment for interrupt to process
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send new instructions
    const prompt = `
## INTERRUPT: Task Change

Your current task has been interrupted. Reason:
${reason}

### What To Do:
1. Stop your current work
2. Commit any changes so far: \`git commit -m "WIP: interrupted - ${reason}"\`
3. Push your branch: \`git push origin worker-${workerId}\`
   Do not force push. If push is rejected, stop and report.
4. Wait for new instructions

The Manager will provide new directions shortly.
    `.trim();

    await this.instanceManager.sendPrompt(instanceId, prompt);
    logger.info(`Interrupted worker ${workerId}: ${reason}`);
  }

  /**
   * Get output from a worker (for debugging).
   */
  async getWorkerOutput(workerId: number): Promise<string> {
    const instanceId = `worker-${workerId}`;
    return this.instanceManager.getOutput(instanceId);
  }

  /**
   * Check if a worker is idle.
   */
  isWorkerIdle(workerId: number): boolean {
    const instance = this.instanceManager.getInstance(`worker-${workerId}`);
    return instance?.status === 'idle';
  }

  /**
   * Get all worker IDs.
   */
  getWorkerIds(): number[] {
    return this.instanceManager
      .getInstancesByType('worker')
      .map((i) => i.workerId);
  }
}
