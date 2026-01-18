# `cco`  Claude Code Orchestrator

Orchestrate multiple Claude Code instances to work collaboratively on software projects using the **Claude Agent SDK**. This is intended for **very long horizon tasks** that require parallelization and coordination among AI agents. Tasks like building a full-stack application, refactoring a large codebase, or implementing complex features.

`cco` is designed to be completely hands-off once started, with automatic management of git branches, worktrees, and Claude sessions. The only requirement is to provide high-level project goals in `PROJECT_DIRECTION.md`.

## Key Features

- **Session Continuity**: Workers maintain context across tasks using the SDK's resume capability
- **Real-time Streaming**: Observe agent progress as it happens
- **Built-in Subagents**: Hierarchical delegation without custom protocols
- **Git Safety**: Serialized git operations prevent conflicts

## Overview

Spawns parallel Claude sessions using a hierarchical coordination model:

- **Director** - Coordinates Engineering Managers and merges to main branch (Opus model)
- **Engineering Managers (EMs)** - Lead teams of workers, curate team branches (Sonnet model)
- **Workers** - Execute tasks in isolated git worktrees (Sonnet model)

For smaller projects (workerCount <= engineerManagerGroupSize), uses a flat **Coordinator** model where a single lead developer coordinates all workers.

## Installation

Requirements: Node.js 22+, git, [Claude Code CLI](https://github.com/anthropics/claude-code)

```bash
npm install -g @mohsen/claude-code-orchestrator
```

## Quick Start

Start an orchestration session using the interactive CLI:

```bash
cco start
```

Or with a configuration file:

```bash
cco start --config ./my-config
```

## Configuration

### Directory Setup

1. Create a configuration directory (e.g., `my-config/`)
2. Add `orchestrator.json` (see below)
3. (Optional) Add `api-keys.json` for API key authentication

### `orchestrator.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repositoryUrl` | string | required | Git repository URL |
| `branch` | string | `"main"` | Base branch |
| `gitCloneOptions` | object | `{}` | Clone options: `depth`, `singleBranch`, `noSubmodules` |
| `workerCount` | number | required | Worker instances (1-20) |
| `authMode` | string | `"oauth"` | `oauth`, `api-keys-first`, or `api-keys-only` |
| `logDirectory` | string | config path | Log storage location |
| `engineerManagerGroupSize` | number | `4` | Max workers per EM (triggers hierarchy mode when exceeded) |
| `maxRunDurationMinutes` | number | `120` | Max run duration |
| `taskTimeoutMs` | number | `600000` | Timeout for individual tasks |
| `pollIntervalMs` | number | `5000` | Status check interval |

### `api-keys.json` (optional)

For rate limit rotation, cco offers two authentication modes: OAuth and API keys. By default, it uses OAuth (your regular Claude CLI auth). To use API keys, create an `api-keys.json` file:

```json
[
  { "name": "key-1", "apiKey": "sk-ant-..." },
  { "name": "key-2", "apiKey": "sk-ant-..." }
]
```

Note: Include multiple keys for rotation - cco switches keys upon hitting rate limits.

## Authentication Modes

| Mode | Description |
|------|-------------|
| `oauth` | Start with CLI auth, rotate to API keys if rate limited |
| `api-keys-first` | Start with API keys, fall back to OAuth |
| `api-keys-only` | Only use API keys |

## Target Repository Setup

Add these files to your target repository:

- `PROJECT_DIRECTION.md` - High-level goals for the Director/Coordinator
- `.env` / `.env.local` - Automatically copied to all worktrees

## Architecture

### Flat Mode (Coordinator)
Used when `workerCount <= engineerManagerGroupSize`:
```
Coordinator (Lead Developer)
    ├── worker-1
    ├── worker-2
    └── worker-N
```

### Hierarchy Mode (Director + EMs)
Used when `workerCount > engineerManagerGroupSize`:
```
Director
    ├── em-1
    │   ├── worker sessions...
    │
    └── em-N
        └── worker sessions...
```

## Logs

Each run creates a timestamped folder with:
- `combined.log` - Orchestrator events and agent outputs
- Session-specific logs for debugging

## Graceful Shutdown

Send SIGINT (Ctrl+C) or SIGTERM to gracefully stop all sessions:

```bash
# The orchestrator handles cleanup automatically
kill -SIGINT <pid>
```

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for contributing and development setup.

## License

MIT
