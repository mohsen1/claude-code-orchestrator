#!/bin/bash
set -e

echo "Starting Claude Code instance..."
echo "  WORKER_ID: $WORKER_ID"
echo "  INSTANCE_TYPE: $INSTANCE_TYPE"
echo "  ORCHESTRATOR_URL: $ORCHESTRATOR_URL"

# Configure git identity for commits
git config --global user.email "claude-orchestrator@bot"
git config --global user.name "Claude Orchestrator"
echo "  Git identity configured"

# Copy Claude config if mounted
if [ -f /claude-config/settings.json ]; then
    cp /claude-config/settings.json /root/.claude/settings.json
    echo "  Loaded Claude config from mounted volume"
fi

# If ANTHROPIC_API_KEY is set, we don't need the config file
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "  Using ANTHROPIC_API_KEY environment variable"
fi

# Navigate to the appropriate worktree directory
if [ "$INSTANCE_TYPE" = "manager" ]; then
    cd /repo
    echo "  Working directory: /repo (main branch)"
else
    # Wait for worktree to be created by orchestrator
    WORKTREE_PATH="/repo/worktrees/worker-$WORKER_ID"

    # Wait up to 60 seconds for worktree
    WAIT_TIME=0
    while [ ! -d "$WORKTREE_PATH" ] && [ $WAIT_TIME -lt 60 ]; do
        echo "  Waiting for worktree at $WORKTREE_PATH..."
        sleep 2
        WAIT_TIME=$((WAIT_TIME + 2))
    done

    if [ -d "$WORKTREE_PATH" ]; then
        cd "$WORKTREE_PATH"
        echo "  Working directory: $WORKTREE_PATH"
    else
        echo "  Warning: Worktree not found, using /repo"
        cd /repo
    fi
fi

# Notify orchestrator that we're starting
if [ -n "$ORCHESTRATOR_URL" ]; then
    curl -s -X POST "$ORCHESTRATOR_URL/hooks/container_ready" \
        -H "Content-Type: application/json" \
        -d "{\"instance_id\": \"$INSTANCE_TYPE-$WORKER_ID\", \"worker_id\": $WORKER_ID, \"instance_type\": \"$INSTANCE_TYPE\"}" \
        || echo "  Warning: Could not notify orchestrator"
fi

# Start Claude Code with permission bypass (CRITICAL for non-interactive use)
# The --dangerously-skip-permissions flag is SAFE in our architecture because:
# - All instances run in isolated Docker containers
# - Containers are disposable and have no access to host system
# - Auto-approve is the correct behavior for automated orchestration
exec claude --dangerously-skip-permissions
