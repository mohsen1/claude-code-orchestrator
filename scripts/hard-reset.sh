#!/bin/bash
# scripts/hard-reset.sh - Full reset including persistent data

set -e

echo "=========================================="
echo " HARD RESET"
echo " This will delete ALL orchestrator data!"
echo "=========================================="
echo ""

read -p "Are you sure you want to continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo "Starting hard reset..."
echo ""

# Run normal cleanup first
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/cleanup.sh"

echo ""
echo "Removing persistent volumes..."
docker volume ls --filter "name=repo-data" -q 2>/dev/null | xargs -r docker volume rm 2>/dev/null || true
docker volume ls --filter "name=claude-" -q 2>/dev/null | xargs -r docker volume rm 2>/dev/null || true
echo "  Done"
echo ""

echo "Removing Docker image..."
docker rmi claude-code-orchestrator:latest 2>/dev/null || true
echo "  Done"
echo ""

echo "Removing generated files..."
rm -f docker-compose.yml 2>/dev/null || true
rm -rf ./workspaces 2>/dev/null || true
rm -rf ./claude-configs 2>/dev/null || true
rm -rf ./logs 2>/dev/null || true
echo "  Done"
echo ""

echo "=========================================="
echo " Hard reset complete!"
echo " All orchestrator data has been removed."
echo "=========================================="
