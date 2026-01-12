#!/bin/bash
# scripts/cleanup.sh - Force cleanup orphaned orchestrator resources

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

# Stop and remove orchestrator containers
echo "Stopping Docker containers..."
docker ps -a --filter "label=orchestrator.instance" --format "{{.Names}}" 2>/dev/null | while read container; do
    echo "  Stopping: $container"
    docker stop "$container" 2>/dev/null || true
    docker rm "$container" 2>/dev/null || true
done
echo "  Done"
echo ""

# Remove docker-compose resources
if [ -f "./docker-compose.yml" ]; then
    echo "Running docker-compose down..."
    docker-compose down -v 2>/dev/null || true
    echo "  Done"
    echo ""
fi

# Clean up any orphaned volumes
echo "Cleaning up volumes..."
docker volume ls --filter "name=repo-data" -q 2>/dev/null | xargs -r docker volume rm 2>/dev/null || true
docker volume ls --filter "name=claude-" -q 2>/dev/null | xargs -r docker volume rm 2>/dev/null || true
echo "  Done"
echo ""

# Clean up networks
echo "Cleaning up networks..."
docker network ls --filter "name=orchestrator" -q 2>/dev/null | xargs -r docker network rm 2>/dev/null || true
echo "  Done"
echo ""

echo "Cleanup complete!"
