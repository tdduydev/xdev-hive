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
block() {
  echo "xDev Hive: $file is generated from Hive. Use doc_get + doc_propose (skill_get + skill_propose for a skill) instead of editing it." >&2
  exit 2
}
case "$file" in
  "$root/AGENTS.md"|"$root/CLAUDE.md"|"$root/docs/decisions.md"|AGENTS.md|CLAUDE.md|docs/decisions.md) block ;;
  "$root/.claude/rules/xdev-hive/"*|.claude/rules/xdev-hive/*) block ;;
  # Hive's AGENTS.md beside one the repo wrote itself (roadmap 38f).
  "$root/.xdev-hive/context/"*|.xdev-hive/context/*) block ;;
  # A nested AGENTS.md or a skill is Hive's when it has the managed block (docs for some paths, skills).
  */AGENTS.md|*/.claude/skills/*/SKILL.md|.claude/skills/*/SKILL.md) grep -q 'xdev-hive:start' "$file" 2>/dev/null && block ;;
esac
exit 0
`;

/** Agent-agnostic guard: only the Hive app (HIVE_ADMIN=1) may commit rendered docs. */
export const PRE_COMMIT = String.raw`#!/bin/sh
# xdev-hive: docs rendered from xDev Hive can only be committed by the Hive app.
[ "$HIVE_ADMIN" = "1" ] && exit 0
blocked=$(git diff --cached --name-only | grep -E '^(AGENTS\.md|CLAUDE\.md|docs/decisions\.md|\.claude/rules/xdev-hive/.*|\.xdev-hive/context/.*)$')
# A nested AGENTS.md or a skill is Hive's when it has the managed block, in the commit or before it.
nested=$(git diff --cached --name-only | grep -E '/AGENTS\.md$|^\.claude/skills/[^/]+/SKILL\.md$' | while IFS= read -r f; do
  { git show ":$f" 2>/dev/null; git show "HEAD:$f" 2>/dev/null; } | grep -q 'xdev-hive:start' && printf '%s\n' "$f"
done)
blocked=$(printf '%s\n%s\n' "$blocked" "$nested" | sed '/^$/d')
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

/** TOML basic string: the same escapes as JSON, which is what a Windows path full of backslashes needs. */
const toml = (s: string) => JSON.stringify(s);

const codexBlock = (shim: string, platform: NodeJS.Platform) => {
  const { command, args } = mcpLaunch(shim, [], platform);
  return [
    CODEX_START,
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${toml(command)}`,
    `args = [${args.map(toml).join(", ")}]`,
    'env = { HIVE_AGENT = "codex" }',
    // Codex 0.15x asks before every MCP write (task_claim, memory_write); a headless run has nobody to ask.
    'default_tools_approval_mode = "approve"',
    CODEX_END,
  ].join("\n");
};

/**
 * How an MCP client starts a command on this machine. Windows: a client spawns its servers without a shell, and
 * neither the shim (a .cmd) nor npx (a .cmd too) starts that way — cmd.exe has to run them.
 */
export function mcpLaunch(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "cmd", args: ["/c", command, ...args] } : { command, args };
}

/** Hive's MCP server for an agent on a project: the shim reads the token itself, so the env holds no secret. */
export const hiveMcpServer = (agent: string, project: string) => ({
  command: SHIM_NAME,
  args: [] as string[],
  env: { HIVE_AGENT: agent, HIVE_PROJECT: project },
});

/**
 * The same server for a config file read on this machine only: the shim by its full path, because a program started
 * from Finder, Explorer or the Dock does not get the shell's PATH — `"command": "hive-mcp"` then fails to start
 * (macOS, 3/10: "Executable not found in $PATH: hive-mcp" though ~/.local/bin/hive-mcp was there).
 */
export const hiveMcpServerAt = (shim: string, agent: string, project: string, platform: NodeJS.Platform = process.platform) => ({
  type: "stdio",
  ...mcpLaunch(shim, [], platform),
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

/**
 * Whether a core.hooksPath value already points at this repo's .githooks. Some machines set it
 * as an absolute path (or "./.githooks"), which is the same folder; treating that as a foreign
 * hook kept the agents item from ever showing as installed.
 */
export function isRepoHooksPath(repo: string, value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!value) return false;
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
  const norm = (p: string) => {
    const out = path.resolve(p);
    // Windows and default macOS file systems ignore case, so "/Users/Admin" is the same folder.
    return platform === "win32" || platform === "darwin" ? out.toLowerCase() : out;
  };
  return norm(path.resolve(repo, expanded)) === norm(path.join(repo, ".githooks"));
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
  if (isRepoHooksPath(repo, current)) return { file: label, action: "unchanged" };
  if (current) return { file: label, action: "skipped", note: tr("fileNote.hooksPathSet", { current }) };
  if (apply) git(repo, ["config", "core.hooksPath", ".githooks"]);
  return { file: label, action: "updated", note: ".githooks" };
}

export function installCodexConfig(file: string, shim: string, opts: { apply?: boolean; platform?: NodeJS.Platform } = {}): FileAction {
  const label = "~/.codex/config.toml";
  const block = codexBlock(shim, opts.platform ?? process.platform);
  const before = read(file) ?? "";
  const start = before.indexOf(CODEX_START);
  const end = before.indexOf(CODEX_END);
  let next: string;
  if (start !== -1 && end > start) {
    next = before.slice(0, start) + block + before.slice(end + CODEX_END.length);
  } else if (new RegExp(`^\\[mcp_servers\\.${MCP_NAME}\\]`, "m").test(before)) {
    return { file: label, action: "skipped", note: tr("fileNote.codexOwnEntry", { name: MCP_NAME }) };
  } else {
    next = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before ? "\n" : ""}${block}\n`;
  }
  return writeIfChanged(file, next, label, undefined, opts.apply ?? true);
}

/** Claude Code's own config for this machine: ~/.claude.json, where `claude mcp add --scope local` puts a server. */
export const claudeLocalFile = (home: string) => path.join(home, ".claude.json");

/**
 * Writes `servers` into Claude Code's local scope for `repo`. Local scope, not the repo's .mcp.json, because the
 * entry holds this machine's own path to the shim: .mcp.json is shared through git, and a project server also has
 * to be approved once per repo. The key is the folder Claude Code is started in, exactly as it is on disk.
 * [Unverified] Shape read from Claude Code's docs, not measured here: check with `claude mcp get xdev-hive`.
 */
function installClaudeLocalMcp(home: string, repo: string, servers: Json, apply: boolean): FileAction {
  return mergeJson(
    claudeLocalFile(home),
    "~/.claude.json",
    (j) => {
      const entry: Json = j.projects?.[repo] ?? {};
      return { ...j, projects: { ...j.projects, [repo]: { ...entry, mcpServers: { ...entry.mcpServers, ...servers } } } };
    },
    apply,
  );
}

/**
 * Takes Hive's own `xdev-hive` out of the repo's .mcp.json: it is shared through git but names a command that only
 * works where the shim folder is on PATH, which an agent started from a GUI never has. A `xdev-hive` someone wrote
 * themselves (another command) is left alone.
 */
function removeHiveFromMcpJson(repo: string, apply: boolean): FileAction {
  const file = path.join(repo, ".mcp.json");
  const label = ".mcp.json";
  const before = read(file);
  if (before === null) return { file: label, action: "unchanged" };
  let json: Json;
  try {
    json = JSON.parse(before) as Json;
  } catch {
    return { file: label, action: "skipped", note: tr("fileNote.badJson") };
  }
  const entry = json.mcpServers?.[MCP_NAME];
  if (!entry) return { file: label, action: "unchanged" };
  if (entry.command !== SHIM_NAME) return { file: label, action: "skipped", note: tr("fileNote.ownMcpEntry", { name: MCP_NAME }) };
  const { [MCP_NAME]: _hive, ...rest } = json.mcpServers as Json;
  if (apply) writeFileSync(file, `${JSON.stringify({ ...json, mcpServers: rest }, null, 2)}\n`);
  return { file: label, action: "removed", note: tr("fileNote.movedToClaudeLocal") };
}

export interface InstallAgentsOptions {
  /** Full path of the hive-mcp shim on this machine (shimTarget). */
  shim: string;
  home?: string;
  dryRun?: boolean;
  /** Which OS the config is for; tests build the Windows form on any machine. */
  platform?: NodeJS.Platform;
}

/** Registers Hive's MCP server with Claude Code, Gemini CLI and Codex, and installs the doc guards. dryRun lists what would change. */
export function installAgents(repo: string, project: string, opts: InstallAgentsOptions): FileAction[] {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const apply = !opts.dryRun;
  // Windows: the repo's .mcp.json keeps the plain `npx` entry, which is what every other machine needs; the local
  // scope wins over it with the same command through cmd.exe, so nothing machine-specific is committed.
  const local: Json = {
    [MCP_NAME]: hiveMcpServerAt(opts.shim, "claude", project, platform),
    ...(platform === "win32" && repoFeatures(repo).codegraph ? { codegraph: codegraphMcp(platform) } : {}),
  };
  return [
    installClaudeLocalMcp(home, repo, local, apply),
    removeHiveFromMcpJson(repo, apply),
    mergeJson(
      path.join(repo, ".gemini", "settings.json"),
      ".gemini/settings.json",
      (j) => {
        const names = new Set<string>([j.contextFileName ?? []].flat());
        names.add("AGENTS.md");
        return { ...j, contextFileName: [...names], mcpServers: { ...j.mcpServers, [MCP_NAME]: hiveMcpServer("gemini", project) } };
      },
      apply,
    ),
    installAntigravityMcp(repo, project, { apply, platform }),
    mergeJson(path.join(repo, ".claude", "settings.json"), ".claude/settings.json", withGuardHook, apply),
    writeIfChanged(path.join(repo, ".xdev-hive", "guard-docs.sh"), GUARD_SCRIPT, ".xdev-hive/guard-docs.sh", 0o755, apply),
    installPreCommit(repo, apply),
    configureHooksPath(repo, apply),
    installCodexConfig(path.join(home, ".codex", "config.toml"), opts.shim, { apply, platform }),
  ];
}

/** Repo-local stdio configuration: the shim owns Hive credentials; agy's OAuth never enters this file. */
export function installAntigravityMcp(repo: string, project: string, opts: { apply?: boolean; platform?: NodeJS.Platform; env?: Record<string, string> } = {}): FileAction {
  const launch = mcpLaunch(SHIM_NAME, [], opts.platform);
  return mergeJson(path.join(repo, ".agents", "mcp_config.json"), ".agents/mcp_config.json",
    (j) => ({ ...j, mcpServers: { ...j.mcpServers, [MCP_NAME]: { ...launch, env: { HIVE_AGENT: "antigravity", HIVE_PROJECT: project, ...opts.env } } } }), opts.apply !== false);
}

// ── codegraph and superpowers (optional, per repo) ─────────────────────────────

export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph@1.6.0";
export const SUPERPOWERS_PLUGIN = "superpowers@claude-plugins-official";

const CODEGRAPH_ARGV = { command: "npx", args: ["-y", CODEGRAPH_PACKAGE, "serve", "--mcp"] };
const CODEGRAPH_ENV = { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" };

/** Pinned version, no telemetry, no update check — started the way `platform` needs (Windows: npx is a .cmd). */
export function codegraphMcp(platform: NodeJS.Platform = process.platform) {
  return { type: "stdio", ...mcpLaunch(CODEGRAPH_ARGV.command, CODEGRAPH_ARGV.args, platform), env: { ...CODEGRAPH_ENV } };
}

/** The entry written into a repo's .mcp.json, which every machine of the team reads: plain npx, never cmd.exe. */
export const CODEGRAPH_MCP = { type: "stdio", ...CODEGRAPH_ARGV, env: { ...CODEGRAPH_ENV } };

/**
 * A run's server ends with its agent. In a folder with an index codegraph otherwise starts a shared daemon that
 * stays up after the run, one per worktree. It still watches the files the agent changes.
 */
export const CODEGRAPH_RUN_MCP = { ...codegraphMcp(), env: { ...CODEGRAPH_ENV, CODEGRAPH_NO_DAEMON: "1" } };

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
export function runMcpServers(
  agent: string,
  project: string,
  features: RepoFeatures,
  run: { task: string; id?: string; readOnly?: boolean; /** The local chat reply a leader writes (roadmap 48). */ chatReply?: number },
): Json {
  const hive = hiveMcpServer(agent, project);
  const env = {
    ...hive.env,
    HIVE_TASK: run.task,
    ...(run.id ? { HIVE_RUN: run.id } : {}),
    ...(run.readOnly ? { HIVE_READONLY: "1" } : {}),
    ...(run.chatReply ? { HIVE_CHAT_REPLY: String(run.chatReply) } : {}),
  };
  return {
    // Windows: the shim is a .cmd, which Claude Code cannot start without cmd.exe (agentPath puts its folder on PATH).
    [MCP_NAME]: { ...hive, ...mcpLaunch(SHIM_NAME, []), env },
    ...(features.codegraph ? { codegraph: CODEGRAPH_RUN_MCP } : {}),
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
  /** Which OS the shim is for; tests build the Windows form on any machine. Paths still join the host's way. */
  platform?: NodeJS.Platform;
}

/** Where the shim goes. Windows keeps its own folder, since ~/.local/bin means nothing there. */
export function shimBinDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  return platform === "win32" ? path.join(home, ".xdev-hive", "bin") : path.join(home, ".local", "bin");
}

function shimFile(opts: ShimOptions): { binDir: string; target: string; script: string } {
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const binDir = opts.binDir ?? shimBinDir(platform);
  const target = path.join(binDir, windows ? `${SHIM_NAME}.cmd` : SHIM_NAME);
  const script = windows
    ? `@echo off\r\nrem ${MARK}: MCP launcher installed by xDev Hive\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${opts.electronPath}" "${opts.entry}" %*\r\n`
    : `#!/bin/sh\n# ${MARK}: MCP launcher installed by xDev Hive\nELECTRON_RUN_AS_NODE=1 exec ${shq(opts.electronPath)} ${shq(opts.entry)} "$@"\n`;
  return { binDir, target, script };
}

/** The full path agent configs name, so they do not depend on the shim folder being on PATH. */
export const shimTarget = (opts: ShimOptions): string => shimFile(opts).target;

/** Installs `hive-mcp`, which runs the bundled MCP server with the app's own Electron binary as Node. */
export function installShim(opts: ShimOptions, pathEnv = process.env.PATH ?? ""): ShimReport {
  const { binDir, target, script } = shimFile(opts);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, script);
  if ((opts.platform ?? process.platform) !== "win32") chmodSync(target, 0o755);
  return { path: target, onPath: pathEnv.split(path.delimiter).includes(binDir) };
}

/**
 * installed: points at this app · outdated: a hive-mcp from another build (e.g. dev vs packaged) ·
 * missing: none, or a file of the same name that Hive did not write.
 */
export function shimStatus(opts: ShimOptions, pathEnv: string): ShimReport & { dir: string; state: "installed" | "outdated" | "missing"; foreign: boolean } {
  const { binDir, target, script } = shimFile(opts);
  const current = read(target);
  const onPath = pathEnv.split(path.delimiter).includes(binDir);
  const base = { path: target, dir: binDir, onPath };
  if (current === null) return { ...base, state: "missing", foreign: false };
  if (current === script) return { ...base, state: "installed", foreign: false };
  return { ...base, state: current.includes(MARK) ? "outdated" : "missing", foreign: !current.includes(MARK) };
}
