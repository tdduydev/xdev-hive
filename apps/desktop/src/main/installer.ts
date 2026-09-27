// Wires a repo and this machine to xDev Hive. No Electron imports so it can be unit tested with plain Node.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileAction, ShimReport } from "@xdev-hive/core";
import { git, isGitRepo } from "./git.ts";

export const MCP_NAME = "xdev-hive";
export const SHIM_NAME = "hive-mcp";
const MARK = "xdev-hive";

/** Claude Code PreToolUse hook: exit 2 blocks the edit and stderr is shown to Claude. */
export const GUARD_SCRIPT = String.raw`#!/bin/sh
# xdev-hive: block direct edits of docs rendered from xDev Hive (Claude Code PreToolUse hook).
root=$CLAUDE_PROJECT_DIR
[ -n "$root" ] || root=$(pwd)
file=$(sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$file" in
  "$root/AGENTS.md"|"$root/CLAUDE.md"|"$root/docs/decisions.md"|AGENTS.md|CLAUDE.md|docs/decisions.md)
    echo "xDev Hive: $file is generated from Hive. Use doc_get + doc_propose instead of editing it." >&2
    exit 2 ;;
esac
exit 0
`;

/** Agent-agnostic guard: only the Hive app (HIVE_ADMIN=1) may commit rendered docs. */
export const PRE_COMMIT = String.raw`#!/bin/sh
# xdev-hive: docs rendered from xDev Hive can only be committed by the Hive app.
[ "$HIVE_ADMIN" = "1" ] && exit 0
blocked=$(git diff --cached --name-only | grep -E '^(AGENTS\.md|CLAUDE\.md|docs/decisions\.md)$')
if [ -n "$blocked" ]; then
  echo "xDev Hive: các file sau được quản lý trong Hive, không commit trực tiếp:" >&2
  echo "$blocked" | sed 's/^/  /' >&2
  echo "Đề xuất bằng doc_propose hoặc sửa trong app Hive, rồi bấm Đồng bộ tài liệu." >&2
  exit 1
fi
exit 0
`;

const CODEX_START = `# >>> ${MARK} >>>`;
const CODEX_END = `# <<< ${MARK} <<<`;
const CODEX_BLOCK = [
  CODEX_START,
  `[mcp_servers.${MCP_NAME}]`,
  `command = "${SHIM_NAME}"`,
  "args = []",
  'env = { HIVE_AGENT = "codex" }',
  CODEX_END,
].join("\n");

const mcpEntry = (agent: string, project: string) => ({
  command: SHIM_NAME,
  args: [] as string[],
  env: { HIVE_AGENT: agent, HIVE_PROJECT: project },
});

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

function writeIfChanged(file: string, content: string, label: string, mode?: number): FileAction {
  const before = read(file);
  if (before === content) return { file: label, action: "unchanged" };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
  return { file: label, action: before === null ? "created" : "updated" };
}

type Json = Record<string, any>;

function mergeJson(file: string, label: string, update: (json: Json) => Json): FileAction {
  const before = read(file);
  let json: Json = {};
  if (before !== null) {
    try {
      json = JSON.parse(before) as Json;
    } catch {
      return { file: label, action: "skipped", note: "JSON không hợp lệ, sửa tay trước" };
    }
  }
  return writeIfChanged(file, `${JSON.stringify(update(json), null, 2)}\n`, label);
}

function withGuardHook(settings: Json): Json {
  const hooks: Json = settings.hooks ?? {};
  const pre: Json[] = hooks.PreToolUse ?? [];
  if (JSON.stringify(pre).includes("guard-docs.sh")) return settings;
  const guard = {
    matcher: "Edit|Write|MultiEdit",
    hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.xdev-hive/guard-docs.sh' }],
  };
  return { ...settings, hooks: { ...hooks, PreToolUse: [...pre, guard] } };
}

function installPreCommit(repo: string): FileAction {
  const file = path.join(repo, ".githooks", "pre-commit");
  const existing = read(file);
  if (existing !== null && !existing.includes(MARK)) {
    return { file: ".githooks/pre-commit", action: "skipped", note: "đã có hook khác, thêm kiểm tra của Hive bằng tay" };
  }
  return writeIfChanged(file, PRE_COMMIT, ".githooks/pre-commit", 0o755);
}

function configureHooksPath(repo: string): FileAction {
  const label = "git config core.hooksPath";
  if (!isGitRepo(repo)) return { file: label, action: "skipped", note: "không phải git repo" };
  let current = "";
  try {
    current = git(repo, ["config", "--get", "core.hooksPath"]);
  } catch {
    // not set
  }
  if (current === ".githooks") return { file: label, action: "unchanged" };
  if (current) return { file: label, action: "skipped", note: `đang là ${current}, chép .githooks/pre-commit vào đó` };
  git(repo, ["config", "core.hooksPath", ".githooks"]);
  return { file: label, action: "updated", note: ".githooks" };
}

export function installCodexConfig(file: string): FileAction {
  const label = "~/.codex/config.toml";
  const before = read(file) ?? "";
  const start = before.indexOf(CODEX_START);
  const end = before.indexOf(CODEX_END);
  let next: string;
  if (start !== -1 && end > start) {
    next = before.slice(0, start) + CODEX_BLOCK + before.slice(end + CODEX_END.length);
  } else if (new RegExp(`^\\[mcp_servers\\.${MCP_NAME}\\]`, "m").test(before)) {
    return { file: label, action: "skipped", note: `đã có [mcp_servers.${MCP_NAME}] do bạn tự thêm` };
  } else {
    next = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}${CODEX_BLOCK}\n`;
  }
  return writeIfChanged(file, next, label);
}

/** Registers Hive's MCP server with Claude Code, Gemini CLI and Codex, and installs the doc guards. */
export function installAgents(repo: string, project: string, opts: { home?: string } = {}): FileAction[] {
  const home = opts.home ?? os.homedir();
  return [
    mergeJson(path.join(repo, ".mcp.json"), ".mcp.json", (j) => ({
      ...j,
      mcpServers: { ...j.mcpServers, [MCP_NAME]: mcpEntry("claude", project) },
    })),
    mergeJson(path.join(repo, ".gemini", "settings.json"), ".gemini/settings.json", (j) => {
      const names = new Set<string>([j.contextFileName ?? []].flat());
      names.add("AGENTS.md");
      return { ...j, contextFileName: [...names], mcpServers: { ...j.mcpServers, [MCP_NAME]: mcpEntry("gemini", project) } };
    }),
    mergeJson(path.join(repo, ".claude", "settings.json"), ".claude/settings.json", withGuardHook),
    writeIfChanged(path.join(repo, ".xdev-hive", "guard-docs.sh"), GUARD_SCRIPT, ".xdev-hive/guard-docs.sh", 0o755),
    installPreCommit(repo),
    configureHooksPath(repo),
    installCodexConfig(path.join(home, ".codex", "config.toml")),
  ];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Installs `hive-mcp`, which runs the bundled MCP server with the app's own Electron binary as Node. */
export function installShim(opts: { electronPath: string; entry: string; binDir?: string }): ShimReport {
  const windows = process.platform === "win32";
  const binDir = opts.binDir ?? (windows ? path.join(os.homedir(), ".xdev-hive", "bin") : path.join(os.homedir(), ".local", "bin"));
  const target = path.join(binDir, windows ? `${SHIM_NAME}.cmd` : SHIM_NAME);
  const script = windows
    ? `@echo off\r\nrem ${MARK}: MCP launcher installed by xDev Hive\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${opts.electronPath}" "${opts.entry}" %*\r\n`
    : `#!/bin/sh\n# ${MARK}: MCP launcher installed by xDev Hive\nELECTRON_RUN_AS_NODE=1 exec ${shq(opts.electronPath)} ${shq(opts.entry)} "$@"\n`;
  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, script);
  if (!windows) chmodSync(target, 0o755);
  const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(binDir);
  return { path: target, onPath };
}
