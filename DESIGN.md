# Claude Code Orchestrator - Architecture Refactoring

## Current State (Problems)

### Misleading Terminology

1. **"Workers"** - Currently refers to SDK subagents (Task tool), but they:
   - Are ephemeral (no persistent sessions)
   - Have no worktrees
   - Run within an EM's context
   - Are not the actual units of parallelism

2. **"Engineering Managers"** - Actually the real workers:
   - Have persistent sessions
   - Have dedicated worktrees
   - Run in parallel
   - Do the actual code implementation

3. **"Director"** - Creates work plans, but:
   - The hierarchy Director → EM → Worker is artificial
   - EMs don't really "manage" workers, they just use Task subagents
   - Director is really just a lead/coordinator

4. **`workerCount` / `engineerManagerGroupSize`** - Confusing config:
   - `emCount = ceil(workerCount / engineerManagerGroupSize)`
   - Why not just specify `workerCount` directly as number of parallel workers?

### Hierarchy Mode vs Flat Mode

Current modes don't reflect reality:
- **Hierarchy**: Director + EMs (who use Task subagents)
- **Flat**: Coordinator (who uses Task subagents)

Both are essentially the same pattern: a lead + parallel workers using subagents.

---

## Proposed Architecture

### Simple Two-Layer Model

```
┌─────────────────────────────────────────────────────────────┐
│                          LEAD                                │
│  - Reads PROJECT_DIRECTION.md                                │
│  - Explores codebase (can use Task subagents)               │
│  - Creates work assignments                                  │
│  - Coordinates merges (orchestrator handles git commands)   │
│  - Reassigns work as workers complete                        │
│  - Runs in main repo (READ-ONLY tools to avoid git locks)  │
│  - Tools: Read, Glob, Grep, Task (NO Write/Edit/Bash)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Assigns work to
                              ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   WORKER 1   │  │   WORKER 2   │  │   WORKER N   │
│              │  │              │  │              │
│ - Worktree   │  │ - Worktree   │  │ - Worktree   │
│ - Own branch │  │ - Own branch │  │ - Own branch │
│ - Parallel   │  │ - Parallel   │  │ - Parallel   │
│ - opus       │  │ - opus       │  │ - opus       │
│              │  │              │  │              │
│ Can use Task │  │ Can use Task │  │ Can use Task │
│ subagents    │  │ subagents    │  │ subagents    │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Simplified Terminology

| Old Term | New Term | Description |
|----------|----------|-------------|
| Director/Coordinator | **Lead** | Creates assignments, coordinates, merges |
| Engineering Manager | **Worker** | Parallel worker with worktree |
| Worker (subagent) | **Subagent** | Task tool helper (ephemeral) |
| workerCount + emGroupSize | **workerCount** | Number of parallel workers |
| hierarchy/flat modes | (removed) | Just one simple model |

### Simplified Config

```json
{
  "repositoryUrl": "git@github.com:user/repo.git",
  "branch": "main",
  "workerCount": 4,
  "model": "opus",
  "maxRunDurationMinutes": 60
}
```

Single `model` field applies to all agents (Lead and Workers).

**Cost Note**: Running multiple Workers on opus is expensive. For cost-sensitive deployments, consider using sonnet. The quality/cost tradeoff is the user's choice.

---

## Workflow

### 1. Initialization
```
1. Clone repo to workspace/repo
2. Create workerCount worktrees: workspace/worktrees/worker-{1..N}
3. Create Lead session (in main repo)
4. Create Worker sessions (in worktrees)
```

### 2. Iteration Loop
```
while (time remaining && work to do):

    # Phase 1: Planning
    Lead reads PROJECT_DIRECTION.md and codebase
    Lead can use Task subagents for exploration
    Lead outputs JSON assignments for workers

    # Phase 2: Parallel Execution
    For each worker (in parallel):
        Worker receives assignment
        Worker implements changes
        Worker can use Task subagents for parallel subtasks
        Worker commits and pushes to worker-N branch

    # Phase 3: Continuous Merge
    As each worker completes:
        Merge worker-N branch to main
        Ask Lead if more work needed
        If yes, assign new work to that worker

    # Phase 4: Sync
    Pull latest to all worktrees
```

### 3. Merge Strategy & Conflict Resolution

The **Orchestrator** (not Lead) handles all git merge operations:

```
Worker completes → Orchestrator merges worker-N to main
                         │
                         ├── Success: Worker gets new assignment
                         │
                         └── Conflict: Worker resolves it
                                │
                                └── Worker pulls main, resolves, pushes again
```

**Key Principles:**
- Orchestrator runs `git merge` commands (not agents)
- Workers resolve their own conflicts (scales better)
- Lead never writes to repo (read-only to avoid locks)

**Conflict Resolution Flow:**
1. Orchestrator attempts merge of `worker-N` to `main`
2. If conflict, Orchestrator tells Worker: "Merge conflict. Pull main, resolve, push again."
3. Worker pulls, resolves conflicts in its worktree, pushes
4. Orchestrator retries merge

### 4. Subagent Usage

Both Lead and Workers can use Task tool to spawn subagents:

**Lead subagents** (for exploration):
- Parallel file reading
- Codebase analysis
- Research tasks

**Worker subagents** (for implementation):
- Parallel file operations
- Independent subtasks
- Testing in isolation

Subagent usage is optional and at the agent's discretion.

---

## Prompt Changes

### Old EM Prompt (Artificial Team Structure)
```
You are EM-1 managing workers 1, 2, 3.
Delegate tasks to your workers using the Task tool.
```

### New Worker Prompt (Flexible Subagent Usage)
```
You are Worker-1. Implement the assigned task.
You can use Task subagents for parallel subtasks if helpful.
```

The difference: No artificial team structure. Workers decide when subagents are useful.

---

## Code Changes Required

### 1. Rename Types
```typescript
// Old
OrchestratorMode = 'flat' | 'hierarchy'
SessionRole = 'director' | 'engineering-manager' | 'worker' | 'coordinator'

// New
SessionRole = 'lead' | 'worker'
// Remove OrchestratorMode entirely
```

### 2. Simplify Config
```typescript
interface OrchestratorConfig {
  repositoryUrl: string;
  branch: string;
  workspaceDir: string;

  workerCount: number;  // Direct, no calculation needed
  model: 'opus' | 'sonnet' | 'haiku';  // Single model for all

  maxRunDurationMinutes: number;
  // ... other settings
}
```

### 3. Remove Hierarchy/Flat Mode Logic
- Delete `createFlatStructure()` and `createHierarchyStructure()`
- Single `createTeamStructure()` that creates lead + workers
- Remove mode checks throughout codebase
- Remove `OrchestratorMode` type

### 4. Simplify Agent Definitions
```typescript
// agents.ts
export function createLeadAgent(workerCount: number): AgentDefinition { ... }
export function createWorkerAgent(workerId: number): AgentDefinition { ... }

// Remove:
// - createDirectorAgent
// - createEngineeringManagerAgent
// - createCoordinatorAgent
// - createTeamAgents (mode-based)
// - createLeadAgent (mode-based)
```

### 5. Update Session Manager
- Remove `coordinator`, `director`, `engineering-manager` role handling
- Just `lead` and `worker` roles

### 6. Files to Modify
- `src/types.ts` - Remove modes, simplify roles
- `src/orchestrator.ts` - Remove mode logic, single team structure
- `src/agents.ts` - Simplify to Lead + Worker
- `src/session-manager.ts` - Update role handling
- `src/config/schema.ts` - Simplify config schema
- `src/cli/commands/start.ts` - Update config building

---

## Migration

### Config Migration

**IMPORTANT**: Old `workerCount` meant something different!
- Old: `workerCount` = conceptual workers, `engineerManagerGroupSize` = workers per EM
- Old: Actual parallelism = `ceil(workerCount / engineerManagerGroupSize)` = number of EMs
- New: `workerCount` = actual parallel workers (what was EMs)

```json
// Old config
{
  "workerCount": 12,              // conceptual workers
  "engineerManagerGroupSize": 4   // workers per EM
  // Actual parallelism: ceil(12/4) = 3 EMs
}

// New config (equivalent)
{
  "workerCount": 3   // 3 parallel workers (was 3 EMs)
}
```

### Backwards Compatibility
- If old config detected (has `engineerManagerGroupSize`):
  - Calculate `newWorkerCount = ceil(oldWorkerCount / engineerManagerGroupSize)`
  - Use `newWorkerCount` as the actual worker count
  - Log deprecation warning:
    ```
    DEPRECATED: engineerManagerGroupSize is no longer used.
    Migrating: workerCount 12 / groupSize 4 = 3 parallel workers.
    Update your config to: { "workerCount": 3 }
    ```

---

## Edge Cases

### workerCount = 1
- 1 Lead + 1 Worker = 2 sessions
- Worker does implementation, Lead coordinates
- Slightly more overhead than old flat mode, but cleaner model

### workerCount = 0
- Invalid, require at least 1 worker
- Or: Lead does everything (like old flat mode)?
- Recommendation: Require workerCount >= 1

---

## Benefits

1. **Clarity**: Names match reality (Lead leads, Workers work)
2. **Simplicity**: One model instead of two modes
3. **Quality**: All opus for best results
4. **Flexibility**: Subagent usage at agent's discretion
5. **Maintainability**: Less conditional logic, fewer code paths
6. **Understandability**: Easier to explain and reason about

---

## Implementation Order

1. Update types (SessionRole, remove OrchestratorMode)
2. Simplify config schema
3. Update agent definitions (Lead + Worker)
4. Refactor orchestrator (remove mode logic)
5. Update session manager
6. Update CLI
7. Update e2e config
8. Test
