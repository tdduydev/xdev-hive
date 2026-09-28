# Image for agent runs in a container (a profile with "Run in a container"). Build it on the machine:
#   docker build -t xdev-hive-agent https://github.com/tdduydev/xdev-hive.git#main:docker/agent
# The app runs it as your own user id, with your home as an empty tmpfs, plus the task's worktree,
# the repo's .git and the CLI's login folder mounted at the same paths as on the machine.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Pin a CLI with --build-arg (e.g. --build-arg CLAUDE_CODE=2.1.283) when a new release breaks something.
ARG CLAUDE_CODE=latest
ARG CODEX=latest
ARG GEMINI_CLI=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE}" "@openai/codex@${CODEX}" "@google/gemini-cli@${GEMINI_CLI}" \
  && npm cache clean --force

# Gemini CLI reaches Hive through the hub's MCP, from variables the app sets (HIVE_HUB_URL, HIVE_HUB_TOKEN…):
# system settings win over the repo's .gemini/settings.json, which points at the machine's hive-mcp shim.
# Folder trust is off: the container only ever sees the task's worktree.
# Root-owned and not writable by others, or Gemini skips it (the folder too, and it must be listable).
RUN mkdir -p /etc/gemini-cli && chmod 755 /etc/gemini-cli
COPY --chmod=644 gemini-settings.json /etc/gemini-cli/settings.json

# The app passes the command (claude, codex or gemini) and its arguments.
CMD ["bash"]
