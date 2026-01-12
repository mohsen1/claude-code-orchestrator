import { simpleGit, SimpleGit } from 'simple-git';
import { logger } from '../utils/logger.js';

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  message?: string;
}

export class BranchMerger {
  private git: SimpleGit;

  constructor(workDir: string) {
    this.git = simpleGit(workDir);
  }

  /**
   * Merge a branch into the target branch.
   */
  async mergeBranch(
    sourceBranch: string,
    targetBranch: string = 'main'
  ): Promise<MergeResult> {
    try {
      // Ensure we're on the target branch
      await this.git.checkout(targetBranch);

      // Pull latest changes
      try {
        await this.git.pull('origin', targetBranch);
      } catch {
        // Ignore pull errors (might be offline or no upstream)
      }

      // Fetch the source branch
      await this.git.fetch('origin', sourceBranch);

      // Merge the source branch
      await this.git.merge([
        `origin/${sourceBranch}`,
        '--no-ff',
        '-m',
        `Merge ${sourceBranch} into ${targetBranch}`,
      ]);

      logger.info(`Successfully merged ${sourceBranch} into ${targetBranch}`);
      return { success: true };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('CONFLICT')) {
        const status = await this.git.status();
        const conflicts = status.conflicted;

        logger.warn(`Merge conflicts in ${sourceBranch}`, { conflicts });

        return { success: false, conflicts };
      }

      logger.error(`Merge failed: ${sourceBranch} -> ${targetBranch}`, err);
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Abort an in-progress merge.
   */
  async abortMerge(): Promise<void> {
    try {
      await this.git.merge(['--abort']);
      logger.info('Merge aborted');
    } catch {
      // Merge might not be in progress
    }
  }

  /**
   * Resolve a conflict by choosing one side.
   */
  async resolveConflict(filePath: string, resolution: 'ours' | 'theirs'): Promise<void> {
    await this.git.checkout([`--${resolution}`, filePath]);
    await this.git.add(filePath);
    logger.info(`Resolved conflict in ${filePath} using ${resolution}`);
  }

  /**
   * Complete a merge after conflicts have been resolved.
   */
  async completeMerge(message?: string): Promise<void> {
    await this.git.commit(message || 'Resolved merge conflicts');
    logger.info('Merge completed after conflict resolution');
  }

  /**
   * Generate a message for the manager about merge conflicts.
   */
  generateConflictNotification(
    workerId: number,
    sourceBranch: string,
    conflicts: string[]
  ): string {
    return `
## Merge Conflict Alert

Merge failed for **Worker ${workerId}** (branch: \`${sourceBranch}\`).

### Conflicting files:
${conflicts.map((f) => `- \`${f}\``).join('\n')}

### Resolution options:
1. **Manual resolution**: Review and edit the conflicting files, then:
   \`\`\`bash
   git add <resolved-files>
   git commit -m "Resolved conflicts in ${sourceBranch}"
   \`\`\`

2. **Accept worker's changes**:
   \`\`\`bash
   git checkout --theirs ${conflicts.join(' ')}
   git add ${conflicts.join(' ')}
   git commit -m "Accepted ${sourceBranch} changes"
   \`\`\`

3. **Keep main's changes**:
   \`\`\`bash
   git checkout --ours ${conflicts.join(' ')}
   git add ${conflicts.join(' ')}
   git commit -m "Kept main changes over ${sourceBranch}"
   \`\`\`

4. **Instruct worker to rebase**: Tell Worker ${workerId} to:
   \`\`\`bash
   git fetch origin main
   git rebase origin/main
   # Resolve conflicts locally
   git push --force-with-lease
   \`\`\`
    `.trim();
  }

  /**
   * Check if there's a merge in progress.
   */
  async isMergeInProgress(): Promise<boolean> {
    const status = await this.git.status();
    return status.conflicted.length > 0;
  }

  /**
   * Get the diff between two branches.
   */
  async getDiff(sourceBranch: string, targetBranch: string = 'main'): Promise<string> {
    const result = await this.git.diff([`${targetBranch}...${sourceBranch}`]);
    return result;
  }

  /**
   * Get summary of changes between branches.
   */
  async getDiffSummary(
    sourceBranch: string,
    targetBranch: string = 'main'
  ): Promise<{ files: number; insertions: number; deletions: number }> {
    const result = await this.git.diffSummary([`${targetBranch}...${sourceBranch}`]);
    return {
      files: result.files.length,
      insertions: result.insertions,
      deletions: result.deletions,
    };
  }
}
