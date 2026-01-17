# Development Guide

This guide covers setting up and contributing to the Claude Code Orchestrator project.

## Prerequisites

- Node.js 22+
- `git`
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Setup

```bash
git clone https://github.com/mohsen/claude-code-orchestrator.git
cd claude-code-orchestrator
npm install
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run directly with tsx (development mode) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run using compiled files |
| `npm test` | Run unit and integration tests |
| `npm run e2e` | Run end-to-end tests |

## Project Structure

```
src/
├── index.ts              # Main entry point - exports v3 components
├── cli/                  # CLI commands
│   ├── index.ts          # CLI entry point (cco command)
│   └── commands/
│       └── start.ts      # Start command handler
├── v3/                   # V3 Agent SDK-based orchestration
│   ├── index.ts          # V3 module exports
│   ├── types.ts          # Type definitions
│   ├── orchestrator.ts   # Main orchestrator using Agent SDK
│   ├── session-manager.ts # Session lifecycle management
│   ├── agents.ts         # Agent definitions (worker, EM, director)
│   └── hooks.ts          # SDK hooks (git safety, audit, etc.)
├── config/               # Configuration loading and validation
│   ├── loader.ts         # Config file loading
│   └── schema.ts         # Zod schema validation
├── git/                  # Git operations
│   └── worktree.ts       # Worktree management
└── utils/                # Utilities
    ├── logger.ts         # Structured logging
    └── repo.ts           # Repository utilities
```

## Architecture

### Agent SDK Foundation

The orchestrator uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) which provides:

- **Session Continuity**: Workers maintain context via `resume` option
- **Subagents**: Built-in hierarchical delegation
- **Hooks**: `PreToolUse` and `PostToolUse` for interception
- **Streaming**: Real-time message observation

### Modes

**Flat Mode** (workerCount <= engineerManagerGroupSize):
- Single Coordinator (Sonnet) manages all workers
- Workers are subagents of the Coordinator

**Hierarchy Mode** (workerCount > engineerManagerGroupSize):
- Director (Opus) coordinates Engineering Managers
- EMs (Sonnet) are subagents of Director
- Workers are managed sessions coordinated by EMs via prompts (SDK limitation: subagents cannot spawn subagents)

### Key Concepts

- **Git Worktrees**: Each worker operates in an isolated worktree to prevent conflicts
- **Rate Limit Rotation**: Automatic rotation through OAuth and API keys on 429 errors
- **Session Persistence**: Session IDs saved to `sessions.json` for resume across restarts
- **Git Safety Hooks**: Serialized git operations via SDK hooks

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run tests/unit/config-loader.test.ts

# Run tests in watch mode
npx vitest watch

# Run with coverage
npx vitest run --coverage

# Run e2e tests
npm run e2e
```

## E2E Testing

End-to-end tests verify the full orchestration flow:

```bash
# Run with default settings
npm run e2e

# Test flat mode specifically
npm run e2e -- --em-group-size 10

# Test hierarchy mode
npm run e2e -- --em-group-size 2
```

E2E tests:
1. Create a test repository
2. Add PROJECT_DIRECTION.md with test tasks
3. Run the orchestrator
4. Verify code was generated

## Debugging

Logs are stored in the configured `logDirectory`:

- `combined.log` - Orchestrator event stream
- Run-specific timestamped directories with detailed logs

### Viewing Logs

```bash
# Follow combined log
tail -f ./my-config/run-*/combined.log

# Check for errors
grep -i error ./my-config/run-*/combined.log
```

## Configuration Schema

The orchestrator config is validated with Zod. See `src/config/schema.ts` for the full schema.

Key fields:
- `repositoryUrl` (required) - Git repository to orchestrate
- `branch` (default: "main") - Base branch
- `workerCount` (required) - Number of parallel workers (1-20)
- `engineerManagerGroupSize` (default: 4) - Triggers hierarchy mode when exceeded
- `authMode` (default: "oauth") - Authentication strategy

## SDK Types

The Agent SDK provides TypeScript types for all interactions. Key types:

```typescript
import {
  query,
  type SDKMessage,
  type SDKResultSuccess,
  type AgentDefinition,
  type Options as SDKOptions,
} from '@anthropic-ai/claude-agent-sdk';
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Run `npm run build` and `npm test`
5. Submit a pull request

## Troubleshooting

### Session Resume Failures
Sessions have TTL. If resume fails, the orchestrator creates a fresh session with context summary.

### Rate Limits
The orchestrator automatically rotates API keys. Ensure multiple keys in `api-keys.json` for production use.

### Git Conflicts
Git operations are serialized via hooks. If conflicts occur, they're detected and reported for manual resolution.
