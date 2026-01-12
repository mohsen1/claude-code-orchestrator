# Claude Code Orchestrator

A distributed system for orchestrating multiple Claude Code instances to work collaboratively on software projects.

## Overview

The orchestrator spawns multiple Claude Code instances that work in parallel on a shared codebase. A Manager instance delegates tasks to Worker instances, each operating in isolated git worktrees. Workers complete tasks, push to their branches, and the Manager merges changes back to main.

## Features

- Manager/Worker architecture with event-driven coordination
- Git worktree isolation for parallel development
- Automatic rate limit detection and config rotation
- OAuth and API key authentication support
- Health monitoring and stuck detection
- Cost tracking and usage limits

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (uses host OAuth)
npm run local -- --config ./config

# Run with Docker (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY="sk-ant-..."
npm run dev -- --config ./config
```

## Configuration

Create a config directory with the following files:

### orchestrator.json (required)

```json
{
  "repositoryUrl": "https://github.com/org/repo.git",
  "branch": "main",
  "workerCount": 2,
  "claudeConfigs": "~/.claude-configs/*.json",
  "hookServerPort": 3000,
  "maxRunDurationMinutes": 120
}
```

### api-keys.json (optional, for rate limit rotation)

```json
[
  { "name": "z.ai-1", "primaryApiKey": "sk-ant-...", "source": "z.ai" },
  { "name": "z.ai-2", "primaryApiKey": "sk-ant-...", "source": "z.ai" }
]
```

## Architecture

```
Orchestrator (Node.js)
    |
    +-- Hook Server (Express) <-- receives events from Claude instances
    |
    +-- Manager Instance (tmux + claude)
    |       |
    |       +-- Reads PROJECT_DIRECTION.md
    |       +-- Creates WORKER_N_TASK_LIST.md files
    |       +-- Merges worker branches
    |
    +-- Worker 1 (tmux + claude, worktree: worker-1)
    |       +-- Reads task list, executes, commits, pushes
    |
    +-- Worker 2 (tmux + claude, worktree: worker-2)
            +-- Reads task list, executes, commits, pushes
```

## Rate Limit Rotation

When running locally, the orchestrator automatically rotates authentication when rate limited:

1. OAuth (default, uses ~/.claude/settings.json)
2. API Key 1 from api-keys.json
3. API Key 2 from api-keys.json
4. Back to OAuth (after cooldown)

## Repository Setup

Your target repository should include a `PROJECT_DIRECTION.md` file that describes what to build. The Manager reads this file and creates task lists for workers.

### Environment Files

The orchestrator automatically copies `.env` and `.env.local` files from the main repository to each worker's worktree. This ensures environment variables are available in all parallel workspaces.

Supported env files:
- `.env` - Main environment variables
- `.env.local` - Local overrides (not committed to git)

These files are copied (not symlinked) to maintain isolation between worktrees.

Example PROJECT_DIRECTION.md:

```markdown
# Project Direction

Build a REST API with the following endpoints:
- GET /users - list all users
- POST /users - create a user
- GET /users/:id - get a user

Use Express.js and TypeScript. Include tests.
```

## Commands

```bash
npm run local   # Run without Docker (OAuth + API key rotation)
npm run dev     # Run with Docker (requires ANTHROPIC_API_KEY)
npm run build   # Compile TypeScript
npm test        # Run tests
```

## Scripts

```bash
./scripts/setup.sh      # Initial setup
./scripts/cleanup.sh    # Clean orphaned resources
./scripts/hard-reset.sh # Full data reset
```

## Requirements

- Node.js 22+
- Docker (for containerized mode)
- tmux
- git
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## License

MIT
