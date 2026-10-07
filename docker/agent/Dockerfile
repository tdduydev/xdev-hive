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
ARG KILO_CLI=7.8.3
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE}" "@openai/codex@${CODEX}" "@google/gemini-cli@${GEMINI_CLI}" "@kilocode/cli@${KILO_CLI}" \
  && npm cache clean --force

# Vibe needs Python >=3.12; uv manages that runtime and pins the adapter's verified CLI contract.
COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /uvx /usr/local/bin/
ARG MISTRAL_VIBE=2.26.0
RUN UV_TOOL_DIR=/opt/uv/tools UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_TOOL_BIN_DIR=/usr/local/bin \
    uv tool install --python 3.12 "mistral-vibe==${MISTRAL_VIBE}"

# Gemini CLI reaches Hive through the hub's MCP, from variables the app sets (HIVE_HUB_URL, HIVE_HUB_TOKEN…):
# system settings win over the repo's .gemini/settings.json, which points at the machine's hive-mcp shim.
# Folder trust is off: the container only ever sees the task's worktree.
# Root-owned and not writable by others, or Gemini skips it (the folder too, and it must be listable).
# (COPY --chmod would give a new folder the file's mode, and a folder needs x to be entered.)
RUN mkdir -p /etc/gemini-cli /opt/xdev-hive && chmod 755 /etc/gemini-cli /opt/xdev-hive
COPY --chmod=644 gemini-settings.json /etc/gemini-cli/settings.json

# A run with a limited network goes out through this proxy (a second container of this image).
COPY --chmod=644 egress.mjs /opt/xdev-hive/egress.mjs

# The app passes the command (claude, codex or gemini) and its arguments.
CMD ["bash"]
