#!/bin/bash
# scripts/setup.sh - Initial setup script

set -e

echo "Setting up Claude Code Orchestrator..."
echo ""

# Check prerequisites
echo "Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed"
    echo "Please install Node.js v22 or higher"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "WARNING: Node.js version is $NODE_VERSION, v22+ recommended"
fi
echo "  Node.js: $(node -v)"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed"
    exit 1
fi
echo "  Docker: $(docker --version)"

# Check docker-compose
if ! command -v docker-compose &> /dev/null; then
    echo "ERROR: docker-compose is not installed"
    exit 1
fi
echo "  docker-compose: $(docker-compose --version)"

# Check tmux
if ! command -v tmux &> /dev/null; then
    echo "ERROR: tmux is not installed"
    exit 1
fi
echo "  tmux: $(tmux -V)"

# Check git
if ! command -v git &> /dev/null; then
    echo "ERROR: git is not installed"
    exit 1
fi
echo "  git: $(git --version)"

echo ""
echo "All prerequisites met!"
echo ""

# Install npm dependencies
echo "Installing npm dependencies..."
npm install
echo ""

# Build TypeScript
echo "Building TypeScript..."
npm run build
echo ""

# Create directories
echo "Creating directories..."
mkdir -p logs
mkdir -p claude-configs
echo ""

# Make scripts executable
echo "Making scripts executable..."
chmod +x scripts/*.sh
echo ""

echo "=========================================="
echo " Setup complete!"
echo ""
echo " Next steps:"
echo " 1. Create a config directory with orchestrator.json"
echo " 2. Add Claude config files matching your claudeConfigs pattern"
echo " 3. Run: npm start -- --config /path/to/config"
echo "=========================================="
