#!/bin/bash
set -e

# E2E Test Script for Claude Code Orchestrator
# This script:
# 1. Creates a temporary branch in the e2e test repo
# 2. Updates orchestrator.json to use that branch
# 3. Runs the orchestrator
# 4. Reverts the config back to main

# Load Volta or nvm if available to ensure node is in PATH
export VOLTA_HOME="$HOME/.volta"
if [ -d "$VOLTA_HOME" ]; then
  export PATH="$VOLTA_HOME/bin:$PATH"
fi
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
fi

# Verify node is available
if ! command -v node &> /dev/null; then
  echo "Error: node not found in PATH"
  exit 1
fi
echo "Using node: $(which node)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/orchestrator.json"
TEMP_BRANCH="e2e-run-$(date +%Y%m%d-%H%M%S)"
REPO_URL="git@github.com:mohsen1/claude-code-orchestrator-e2e-test.git"

echo "=== E2E Test Starting ==="
echo "Temp branch: $TEMP_BRANCH"

# First, ensure config is reset to main (in case previous run was interrupted)
sed -i.bak 's/"branch": "[^"]*"/"branch": "main"/' "$CONFIG_FILE"
rm -f "$CONFIG_FILE.bak"

# Cleanup function
cleanup() {
  echo "=== Cleaning up ==="
  # Revert config to main
  sed -i.bak 's/"branch": "[^"]*"/"branch": "main"/' "$CONFIG_FILE"
  rm -f "$CONFIG_FILE.bak"
  echo "Config reverted to main branch"
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create temp branch in the e2e test repo
echo "=== Creating temp branch in e2e test repo ==="
TEMP_DIR=$(mktemp -d)
git clone --depth 1 "$REPO_URL" "$TEMP_DIR"
cd "$TEMP_DIR"
git checkout -b "$TEMP_BRANCH"
git push -u origin "$TEMP_BRANCH"
cd -
rm -rf "$TEMP_DIR"

# Update config to use temp branch
echo "=== Updating config to use temp branch ==="
sed -i.bak 's/"branch": "main"/"branch": "'"$TEMP_BRANCH"'"/' "$CONFIG_FILE"
rm -f "$CONFIG_FILE.bak"
cat "$CONFIG_FILE"

# Clean workspace (but not run-e2e.sh!)
echo "=== Cleaning workspace ==="
rm -rf "$SCRIPT_DIR/workspace" "$SCRIPT_DIR/sessions.json"

# Run orchestrator
echo "=== Running Orchestrator ==="
cd "$SCRIPT_DIR/.."
npm start -- start -c ./e2e

echo "=== E2E Test Complete ==="
