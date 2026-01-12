FROM node:24-bookworm

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    tmux \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory
WORKDIR /workspace

# Create claude config directory
RUN mkdir -p /root/.claude

# Environment variables (overridden at runtime)
ENV WORKER_ID=""
ENV TOTAL_WORKERS=""
ENV INSTANCE_TYPE=""
ENV ORCHESTRATOR_URL=""

# Entry point script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
