// Wires a repo and this machine to xDev Hive. No Electron imports so it can be unit tested with plain Node.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileAction, ShimReport } from "@xdev-hive/core";
import { git, isGitRepo } from "./git.ts";
import { tr } from "./i18n.ts";

export const MCP_NAME = "xdev-hive";
export const SHIM_NAME = "hive-mcp";
const MARK = "xdev-hive";

/** Files rendered from Hive docs. Only the Hive app commits them. */
export const RENDERED_FILES = ["AGENTS.md", "CLAUDE.md", "docs/decisions.md"];

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

/** apply=false plans the change without touching disk (used by the setup status check). */
function writeIfChanged(file: string, content: string, label: string, mode?: number, apply = true): FileAction {
  const before = read(file);
  if (before === content) return { file: label, action: "unchanged" };
  if (apply) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (mode) chmodSync(file, mode);
  }
  return { file: label, action: before === null ? "created" : "updated" };
}

type Json = Record<string, any>;

function mergeJson(file: string, label: string, update: (json: Json) => Json, apply = true): FileAction {
  const before = read(file);
  let json: Json = {};
  if (before !== null) {
    try {
      json = JSON.parse(before) as Json;
    } catch {
      return { file: label, action: "skipped", note: tr("fileNote.badJson") };
    }
  }
  const next = update(json);
  // Same data in another layout is not a change: keep the user's formatting.
  if (before !== null && JSON.stringify(next) === JSON.stringify(json)) return { file: label, action: "unchanged" };
  return writeIfChanged(file, `${JSON.stringify(next, null, 2)}\n`, label, undefined, apply);
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

function installPreCommit(repo: string, apply: boolean): FileAction {
  const file = path.join(repo, ".githooks", "pre-commit");
  const existing = read(file);
  if (existing !== null && !existing.includes(MARK)) {
    return { file: ".githooks/pre-commit", action: "skipped", note: tr("fileNote.otherHook") };
  }
  return writeIfChanged(file, PRE_COMMIT, ".githooks/pre-commit", 0o755, apply);
}

function configureHooksPath(repo: string, apply: boolean): FileAction {
  const label = "git config core.hooksPath";
  if (!isGitRepo(repo)) return { file: label, action: "skipped", note: tr("fileNote.notGitRepo") };
  let current = "";
  try {
    current = git(repo, ["config", "--get", "core.hooksPath"]);
  } catch {
    // not set
  }
  if (current === ".githooks") return { file: label, action: "unchanged" };
  if (current) return { file: label, action: "skipped", note: tr("fileNote.hooksPathSet", { current }) };
  if (apply) git(repo, ["config", "core.hooksPath", ".githooks"]);
  return { file: label, action: "updated", note: ".githooks" };
}

export function installCodexConfig(file: string, apply = true): FileAction {
  const label = "~/.codex/config.toml";
  const before = read(file) ?? "";
  const start = before.indexOf(CODEX_START);
  const end = before.indexOf(CODEX_END);
  let next: string;
  if (start !== -1 && end > start) {
    next = before.slice(0, start) + CODEX_BLOCK + before.slice(end + CODEX_END.length);
  } else if (new RegExp(`^\\[mcp_servers\\.${MCP_NAME}\\]`, "m").test(before)) {
    return { file: label, action: "skipped", note: tr("fileNote.codexOwnEntry", { name: MCP_NAME }) };
  } else {
    next = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}${CODEX_BLOCK}\n`;
  }
  return writeIfChanged(file, next, label, undefined, apply);
}

/** Registers Hive's MCP server with Claude Code, Gemini CLI and Codex, and installs the doc guards. dryRun lists what would change. */
export function installAgents(repo: string, project: string, opts: { home?: string; dryRun?: boolean } = {}): FileAction[] {
  const home = opts.home ?? os.homedir();
  const apply = !opts.dryRun;
  return [
    mergeJson(
      path.join(repo, ".mcp.json"),
      ".mcp.json",
      (j) => ({ ...j, mcpServers: { ...j.mcpServers, [MCP_NAME]: mcpEntry("claude", project) } }),
      apply,
    ),
    mergeJson(
      path.join(repo, ".gemini", "settings.json"),
      ".gemini/settings.json",
      (j) => {
        const names = new Set<string>([j.contextFileName ?? []].flat());
        names.add("AGENTS.md");
        return { ...j, contextFileName: [...names], mcpServers: { ...j.mcpServers, [MCP_NAME]: mcpEntry("gemini", project) } };
      },
      apply,
    ),
    mergeJson(path.join(repo, ".claude", "settings.json"), ".claude/settings.json", withGuardHook, apply),
    writeIfChanged(path.join(repo, ".xdev-hive", "guard-docs.sh"), GUARD_SCRIPT, ".xdev-hive/guard-docs.sh", 0o755, apply),
    installPreCommit(repo, apply),
    configureHooksPath(repo, apply),
    installCodexConfig(path.join(home, ".codex", "config.toml"), apply),
  ];
}

// ── codegraph and superpowers (optional, per repo) ─────────────────────────────

export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph@1.6.0";
export const SUPERPOWERS_PLUGIN = "superpowers@claude-plugins-official";

/** Same entry as this repo's .mcp.json: pinned version, no telemetry, no update check. */
export const CODEGRAPH_MCP = {
  type: "stdio",
  command: "npx",
  args: ["-y", CODEGRAPH_PACKAGE, "serve", "--mcp"],
  env: { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
};

/** Adds the codegraph MCP server to the repo's .mcp.json, unless one is already configured there. */
export function installCodegraphMcp(repo: string, opts: { dryRun?: boolean } = {}): FileAction {
  return mergeJson(
    path.join(repo, ".mcp.json"),
    ".mcp.json",
    (j) => (j.mcpServers?.codegraph ? j : { ...j, mcpServers: { ...j.mcpServers, codegraph: CODEGRAPH_MCP } }),
    !opts.dryRun,
  );
}

export interface RepoFeatures {
  /** The repo's .mcp.json lists codegraph. */
  codegraph: boolean;
  /** The repo's .claude/settings.json enables superpowers. */
  superpowers: boolean;
}

export const NO_FEATURES: RepoFeatures = { codegraph: false, superpowers: false };

const readJson = (file: string): Json => {
  try {
    return JSON.parse(read(file) ?? "{}") as Json;
  } catch {
    return {};
  }
};

/** What setup turned on for a repo, read from its main checkout. Runs get the app's own entries for these. */
export function repoFeatures(repo: string): RepoFeatures {
  return {
    codegraph: Boolean(readJson(path.join(repo, ".mcp.json")).mcpServers?.codegraph),
    superpowers: readJson(path.join(repo, ".claude", "settings.json")).enabledPlugins?.[SUPERPOWERS_PLUGIN] === true,
  };
}

/** MCP servers for one agent run, listed by the app instead of read from the working copy. Task and run go with every write. */
export function runMcpServers(agent: string, project: string, features: RepoFeatures, run: { task: string; id?: string; readOnly?: boolean }): Json {
  const hive = mcpEntry(agent, project);
  const env = { ...hive.env, HIVE_TASK: run.task, ...(run.id ? { HIVE_RUN: run.id } : {}), ...(run.readOnly ? { HIVE_READONLY: "1" } : {}) };
  return {
    [MCP_NAME]: { ...hive, env },
    ...(features.codegraph ? { codegraph: CODEGRAPH_MCP } : {}),
  };
}

/** Enables superpowers in the repo's Claude Code settings (keeps hooks and other plugins). */
export function enableSuperpowers(repo: string, opts: { dryRun?: boolean } = {}): FileAction {
  return mergeJson(
    path.join(repo, ".claude", "settings.json"),
    ".claude/settings.json",
    (j) => (j.enabledPlugins?.[SUPERPOWERS_PLUGIN] === true ? j : { ...j, enabledPlugins: { ...j.enabledPlugins, [SUPERPOWERS_PLUGIN]: true } }),
    !opts.dryRun,
  );
}

// ── hive-mcp shim ──────────────────────────────────────────────────────────────

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ShimOptions {
  electronPath: string;
  entry: string;
  binDir?: string;
}

function shimFile(opts: ShimOptions): { binDir: string; target: string; script: string } {
  const windows = process.platform === "win32";
  const binDir = opts.binDir ?? (windows ? path.join(os.homedir(), ".xdev-hive", "bin") : path.join(os.homedir(), ".local", "bin"));
  const target = path.join(binDir, windows ? `${SHIM_NAME}.cmd` : SHIM_NAME);
  const script = windows
    ? `@echo off\r\nrem ${MARK}: MCP launcher installed by xDev Hive\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${opts.electronPath}" "${opts.entry}" %*\r\n`
    : `#!/bin/sh\n# ${MARK}: MCP launcher installed by xDev Hive\nELECTRON_RUN_AS_NODE=1 exec ${shq(opts.electronPath)} ${shq(opts.entry)} "$@"\n`;
  return { binDir, target, script };
}

/** Installs `hive-mcp`, which runs the bundled MCP server with the app's own Electron binary as Node. */
export function installShim(opts: ShimOptions, pathEnv = process.env.PATH ?? ""): ShimReport {
  const { binDir, target, script } = shimFile(opts);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, script);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  return { path: target, onPath: pathEnv.split(path.delimiter).includes(binDir) };
}

/**
 * installed: points at this app · outdated: a hive-mcp from another build (e.g. dev vs packaged) ·
 * missing: none, or a file of the same name that Hive did not write.
 */
export function shimStatus(opts: ShimOptions, pathEnv: string): ShimReport & { state: "installed" | "outdated" | "missing"; foreign: boolean } {
  const { binDir, target, script } = shimFile(opts);
  const current = read(target);
  const onPath = pathEnv.split(path.delimiter).includes(binDir);
  if (current === null) return { path: target, onPath, state: "missing", foreign: false };
  if (current === script) return { path: target, onPath, state: "installed", foreign: false };
  return { path: target, onPath, state: current.includes(MARK) ? "outdated" : "missing", foreign: !current.includes(MARK) };
}
