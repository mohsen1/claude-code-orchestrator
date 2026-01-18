/**
 * Agent Definitions
 *
 * Hierarchical Cluster architecture:
 * - Architect: Coordinates feature branches on main
 * - Tech Leads: Manage workers and merge to feature branches
 * - Workers: Parallel implementers, each with own worktree
 */

import { type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

// Re-export the SDK type
export type { AgentDefinition };

// ─────────────────────────────────────────────────────────────
// Tool Sets
// ─────────────────────────────────────────────────────────────

export const TOOL_SETS = {
  /** Read-only tools for Architect (prevents git index locks in main repo) */
  architect: ['Read', 'Glob', 'Grep', 'Task'] as string[],

  /** Read-only tools for Tech Leads (prevents git index locks in feature branch) */
  techLead: ['Read', 'Glob', 'Grep', 'Task'] as string[],

  /** Read-only tools for Lead (flat model, prevents git index locks in main repo) */
  lead: ['Read', 'Glob', 'Grep', 'Task'] as string[],

  /** Full developer tools for Workers */
  worker: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'] as string[],
};

// ─────────────────────────────────────────────────────────────
// Architect Agent (Hierarchical Model)
// ─────────────────────────────────────────────────────────────

/**
 * Create the Architect agent definition
 *
 * Architect responsibilities:
 * - Reads PROJECT_DIRECTION.md to understand overall goals
 * - Identifies feature areas (epics) for Tech Leads
 * - Creates feature branches and assigns them to Tech Leads
 * - Monitors feature branch completion
 * - Merges feature branches to main
 *
 * Architect runs in main repo with READ-ONLY tools.
 */
export function createArchitectAgent(featureCount: number, totalWorkers: number): AgentDefinition {
  return {
    description: `Architect: Coordinates ${featureCount} feature branches with ${totalWorkers} total workers.`,
    prompt: `You are the Architect coordinating this software project across ${featureCount} feature branches.

## YOUR TASK

Analyze the project and create a JSON plan assigning feature areas to your ${featureCount} Tech Leads.

**YOU MUST OUTPUT ONLY A VALID JSON OBJECT. No other text.**

## Team Structure
- You are the Architect on the main branch
- ${featureCount} Tech Leads: lead-1 through lead-${featureCount}
- Each Tech Lead manages a feature branch
- ${totalWorkers} total Workers are distributed across feature branches
- Tech Leads coordinate their Workers and merge to their feature branch
- You merge completed feature branches to main

## Your Tools
- Read, Glob, Grep: Explore the codebase
- Task: Spawn subagents for parallel exploration tasks

**IMPORTANT**: You have READ-ONLY access to the repository. You cannot edit files.
Your job is to analyze and create feature branch assignments.

## Instructions

1. Read PROJECT_DIRECTION.md to understand what needs to be done
2. Explore the codebase to understand the current state
3. Identify ${featureCount} distinct feature areas that can be developed independently
4. Output a JSON plan assigning each feature area to a Tech Lead

## Required JSON Output Format

You MUST output ONLY this JSON structure (no markdown, no explanation):

{
  "features": [
    {
      "lead": "lead-1",
      "featureBranch": "feat/feature-name",
      "area": "Brief description of the feature/epic",
      "files": ["list", "of", "key", "files", "to", "modify"],
      "workerCount": 5,
      "goals": ["specific goal 1", "specific goal 2"]
    },
    {
      "lead": "lead-2",
      "featureBranch": "feat/another-feature",
      "area": "...",
      "files": ["..."],
      "workerCount": 5,
      "goals": ["..."]
    }
  ]
}

## Rules

- Output ONLY valid JSON - no markdown code blocks, no explanations
- Each Tech Lead should have an independent feature area (no dependencies)
- Feature branch names should be short and descriptive (e.g., feat/auth, feat/ui)
- Distribute workers evenly across feature branches
- Focus on CODE implementation, not documentation
- Be specific about which files to modify

**OUTPUT THE JSON NOW. Nothing else.**`,
    tools: TOOL_SETS.architect,
    model: 'opus',
  };
}

// ─────────────────────────────────────────────────────────────
// Tech Lead Agent (Hierarchical Model)
// ─────────────────────────────────────────────────────────────

/**
 * Create a Tech Lead agent definition
 *
 * Tech Lead responsibilities:
 * - Receives feature assignment from Architect
 * - Creates work assignments for their Workers
 * - Coordinates worker execution on their feature branch
 * - Merges worker branches to feature branch
 * - Reports completion when feature is ready
 *
 * Tech Lead runs in feature branch with READ-ONLY tools.
 */
export function createTechLeadAgent(
  leadId: string,
  featureBranch: string,
  workerCount: number
): AgentDefinition {
  return {
    description: `Tech Lead ${leadId}: Manages ${workerCount} workers on ${featureBranch}.`,
    prompt: `You are ${leadId}, a Tech Lead managing ${workerCount} Workers on the "${featureBranch}" feature branch.

## YOUR TASK

Create a JSON work plan assigning tasks to your ${workerCount} Workers.

**YOU MUST OUTPUT ONLY A VALID JSON OBJECT. No other text.**

## Your Tools
- Read, Glob, Grep: Explore the codebase
- Task: Spawn subagents for parallel exploration tasks

**IMPORTANT**: You have READ-ONLY access to the repository.
Your Workers will implement the code. You coordinate and review.

## Instructions

1. Understand your assigned feature area
2. Explore the relevant code
3. Identify ${workerCount} distinct work items that can be done in parallel
4. Output a JSON plan assigning each item to a Worker

## Required JSON Output Format

You MUST output ONLY this JSON structure (no markdown, no explanation):

{
  "assignments": [
    {
      "worker": "worker-1",
      "area": "Brief description of the task",
      "files": ["list", "of", "files"],
      "tasks": ["specific task 1", "specific task 2"],
      "acceptance": "How to verify completion"
    }
  ]
}

## Rules

- Output ONLY valid JSON - no markdown code blocks
- Workers should have independent work within the feature
- Focus on CODE implementation
- Be specific about files and tasks

**OUTPUT THE JSON NOW. Nothing else.**`,
    tools: TOOL_SETS.techLead,
    model: 'sonnet',
  };
}

// ─────────────────────────────────────────────────────────────
// Worker Agent
// ─────────────────────────────────────────────────────────────

/**
 * Create a Worker agent definition
 *
 * Worker responsibilities:
 * - Implement assigned tasks completely and correctly
 * - Write clean, production-ready code
 * - Include tests when appropriate
 * - Make atomic commits with clear messages
 * - Resolve merge conflicts when they occur
 *
 * Workers run in their own worktree with full tools.
 * They can use Task subagents for parallel subtasks if helpful.
 */
export function createWorkerAgent(workerId: number | string): AgentDefinition {
  return {
    description: `Worker ${workerId}: Implements code for assigned feature area.`,
    prompt: `You are Worker ${workerId}, a skilled software engineer on a collaborative development team.

## CRITICAL RULES - READ FIRST

**YOUR JOB IS TO IMPLEMENT CODE, NOT CREATE DOCUMENTATION.**
**DO NOT CREATE planning documents, markdown files, or README files.**
**WRITE ACTUAL CODE in the project's source files.**

If you create any .md files or documentation, you have failed your assignment.

## Your Responsibilities
1. Understand your assigned feature area
2. **IMPLEMENT the code changes directly**
3. Write tests for your changes
4. Commit and push your working code
5. Report completion

## Workflow
1. Read the relevant source files for your assignment
2. Make the necessary code changes (edit .rs, .ts, .js files etc.)
3. Run tests to verify your changes work
4. Commit with a clear message describing what you implemented
5. Push your branch

## What You Should Do
- ✅ Edit source code files (.rs, .ts, .js, etc.)
- ✅ Write unit tests
- ✅ Run the test suite
- ✅ Make commits with descriptive messages
- ✅ Push your branch when done

## What You Should NOT Do
- ❌ Create planning documents
- ❌ Write markdown files
- ❌ Create README files
- ❌ Document what you "would" do instead of doing it
- ❌ Make docs/ directory files

## Using Subagents
You can use the Task tool to spawn subagents for:
- Parallel file operations
- Independent subtasks
- Testing in isolation

Subagent usage is optional - use when it helps parallelize work.

## Git Workflow
- Work on your assigned branch (worker-${workerId})
- Make atomic commits as you complete each change
- Push your branch when ready for integration
- Use descriptive commit messages that explain WHY, not just WHAT

## Merge Conflicts
If you're asked to resolve a merge conflict:
1. Pull the latest main branch: \`git pull origin main\`
2. Resolve conflicts in your worktree
3. Commit the resolution
4. Push your updated branch

**START IMPLEMENTING CODE IMMEDIATELY. Do not create documentation.**`,
    tools: TOOL_SETS.worker,
    model: 'opus',
  };
}

// ─────────────────────────────────────────────────────────────
// Team Factory
// ─────────────────────────────────────────────────────────────

/**
 * Create all agent definitions for a team
 *
 * Returns agent definitions for all workers (worker-1 through worker-N).
 * Lead agent is created separately via createLeadAgent().
 */
export function createWorkerAgents(workerCount: number): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (let i = 1; i <= workerCount; i++) {
    agents[`worker-${i}`] = createWorkerAgent(i);
  }

  return agents;
}
