#!/bin/bash
# scripts/cleanup.sh - Force cleanup orchestrator resources

set -e

echo "Cleaning up Claude Code Orchestrator resources..."
echo ""

# Kill all orchestrator tmux sessions
echo "Killing tmux sessions..."
tmux list-sessions 2>/dev/null | grep '^claude-' | cut -d: -f1 | while read session; do
    echo "  Killing session: $session"
    tmux kill-session -t "$session" 2>/dev/null || true
done
echo "  Done"
echo ""

# Clean up workspace
if [ -d "/tmp/orchestrator-workspace" ]; then
    echo "Cleaning up workspace..."
    rm -rf /tmp/orchestrator-workspace
    echo "  Done"
    echo ""
fi

echo "Cleanup complete!"
