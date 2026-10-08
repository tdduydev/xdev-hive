// What is installed on this machine (agent CLIs, Spec Kit's specify, the hive-mcp shim) and in each project
// repo (Hive's agent config, codegraph, superpowers, Spec Kit), and how to install what is missing.
// No Electron imports: the main process provides a SetupHost, tests provide a fake one.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  HiveError,
  POLICY_REPO_PARTS,
  toolArgv,
  toolEnv,
  versionIn,
  versionMatches,
  type AgentKind,
  type DesktopProject,
  type FileAction,
  type MachineTools,
  type SetupInstallResult,
  type SetupItem,
  type SetupReport,
  type ToolEntry,
} from "@xdev-hive/core";
import {
  CODEGRAPH_PACKAGE,
  enableSuperpowers,
  installAgents,
  installCodegraphMcp,
  installShim,
  NO_FEATURES,
  shimStatus,
  shimTarget,
  type ShimOptions,
} from "./installer.ts";
import { addToUserPath, pathHasDir, type UserPath } from "./winpath.ts";
import { tr } from "./i18n.ts";
import { geminiLaunch } from "#desktop/main/runner/gemini-launch.ts";
import { resolveBin } from "./runner/command.ts";
import { VIBE_VERSION } from "#desktop/main/runner/vibe.ts";
import { supportsAgyUsage } from "#desktop/main/runner/antigravity.ts";
import { APP_TOOLS, toolOn, trustOf } from "./runner/tools.ts";
import { insideRuntime } from "#desktop/main/linux-tools.ts";

export interface RunResult {
  ok: boolean;
  output: string;
}

export type Run = (bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

export interface SetupHost {
  /** Login-shell PATH; refresh=true after an install may have changed it. */
  pathEnv(refresh?: boolean): string | Promise<string>;
  /** Linux: folders that go away with the app (its runtime root), where no CLI may be installed. */
  runtimeRoots?(): string[];
  /** Base env for child processes (already carries pathEnv). */
  env(): NodeJS.ProcessEnv;
  projects(): DesktopProject[];
  shim: ShimOptions;
  /** For ~/.codex/config.toml and ~/.claude.json in the agent config check. */
  home?: string;
  /** Which OS the items are for; tests check the Windows ones on any machine. */
  platform?: NodeJS.Platform;
  /** Windows: the user's Path in the registry, which the "Add to PATH" button writes. Absent: no button. */
  registry?: UserPath;
  run?: Run;
  /** The newest version of an npm package (roadmap 33); tests pass their own. Default: `npm view`, else the registry. */
  latest?: (pkg: string, npm: string | null, env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Runs going on with a CLI of this kind: it is not upgraded under them. */
  cliBusy?: (kind: AgentKind) => number;
  /** While a CLI is upgraded the runner starts no run on it. */
  holdCli?: (kind: AgentKind, held: boolean) => void;
  /** The real path of a CLI (symlinks followed), which tells how it was installed. */
  realpath?: (bin: string) => string;
  /** Whether this user can write into `dir` (or the folder that would hold it); tests pass their own. */
  writable?: (dir: string) => boolean;
  /**
   * The hub's tool catalog from the runner's last heartbeat (roadmap 28b). Absent or null (local mode, a hub older
   * than 28b, no heartbeat yet): the machine's items are the app's own, as before the catalog.
   */
  tools?(): MachineTools | null;
  /** The toolHash of each hub tool this machine's user allowed (config.toolTrust). */
  toolTrust?(): Record<string, string>;
}

/** The first dotted version in a CLI's --version output: "2.1.283 (Claude Code)", "codex-cli 0.157.1", "0.61.0". */
export function parseCliVersion(output: string): string | null {
  return /(?<![\w.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?![\w.])/.exec(output)?.[1] ?? null;
}

/** How a CLI upgrades itself; `bin` is a command looked up on PATH, or the CLI's own path. */
export interface CliUpgrade {
  method: "npm" | "native" | "brew";
  bin: string;
  args: string[];
}

/**
 * How the CLI at `real` (its path with symlinks followed) was installed, so it is upgraded the same way and no second
 * copy lands elsewhere on PATH. null: not known, the person upgrades it as they installed it.
 */
export function cliUpgrade(cli: (typeof AGENT_CLIS)[number], real: string, own: string, home?: string): CliUpgrade | null {
  const p = real.replaceAll("\\", "/");
  if (p.includes(`/node_modules/${cli.pkg}/`)) {
    const args = ["install", "-g", `${cli.pkg}@latest`];
    // Installed under the user's own prefix (npm's global one needed root): upgraded there too, or npm tries /usr again.
    const user = home && userNpmPrefix(home).replaceAll("\\", "/");
    if (user && p.startsWith(`${user}/lib/node_modules/`)) args.push("--prefix", userNpmPrefix(home));
    return { method: "npm", bin: "npm", args };
  }
  // Claude Code's native installer (~/.local/share/claude/versions/…) and its older local install (~/.claude/local).
  if (cli.kind === "claude" && (p.includes("/.local/share/claude/") || p.includes("/.claude/local/"))) return { method: "native", bin: own, args: ["update"] };
  if (cli.kind === "opencode" && p.includes("/.opencode/bin/")) return { method: "native", bin: own, args: ["upgrade"] };
  const brew = /\/(Cellar|Caskroom)\/([^/]+)\//.exec(p);
  if (brew) return { method: "brew", bin: "brew", args: brew[1] === "Caskroom" ? ["upgrade", "--cask", brew[2]!] : ["upgrade", brew[2]!] };
  return null;
}

/**
 * Where a CLI goes when npm's global prefix belongs to root (Node from apt on Ubuntu, the nodejs.org pkg on macOS):
 * bins land in ~/.local/bin, which agentPath always includes and Ubuntu's ~/.profile puts on PATH.
 */
export function userNpmPrefix(home: string): string {
  return path.join(home, ".local");
}

/** `dir` or, when it does not exist yet, the nearest folder above it that would hold it. */
function canWrite(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(d)) {
      try {
        accessSync(d, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    if (path.dirname(d) === d) return false;
  }
}

/** The registry's newest version is looked up again after this long; a failed lookup sooner. */
const LATEST_TTL_MS = 6 * 60 * 60_000;
const LATEST_RETRY_MS = 30 * 60_000;

/** `npm view` follows the machine's own registry and proxy (.npmrc); without npm, the public registry. */
async function npmLatest(run: Run, pkg: string, npm: string | null, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (pkg === "google-antigravity/antigravity-cli") {
    try {
      const res = await fetch("https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest", { signal: AbortSignal.timeout(10_000) });
      const json = res.ok ? await res.json() as { tag_name?: unknown } : null;
      return typeof json?.tag_name === "string" ? parseCliVersion(json.tag_name.replace(/^v/, "")) : null;
    } catch { return null; }
  }
  if (npm) {
    const r = await run(npm, ["view", pkg, "version"], { env, timeoutMs: 20_000 });
    return r.ok ? parseCliVersion(r.output) : null;
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(10_000) });
    const json = res.ok ? ((await res.json()) as { version?: unknown }) : null;
    return typeof json?.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

/** The CLIs the default profiles use, and the npm package that provides each. */
export const AGENT_CLIS: Array<{ kind: Exclude<AgentKind, "custom">; bin: string; label: string; pkg: string }> = [
  { kind: "claude", bin: "claude", label: "Claude Code", pkg: "@anthropic-ai/claude-code" },
  { kind: "codex", bin: "codex", label: "Codex CLI", pkg: "@openai/codex" },
  { kind: "antigravity", bin: "agy", label: "Antigravity CLI", pkg: "google-antigravity/antigravity-cli" },
  { kind: "vibe", bin: "vibe", label: "Mistral Vibe", pkg: "mistral-vibe" },
  { kind: "opencode", bin: "opencode", label: "OpenCode", pkg: "opencode-ai" },
  { kind: "kilo", bin: "kilo", label: "Kilo Code CLI", pkg: "@kilocode/cli" },
  { kind: "gemini", bin: "gemini", label: "Gemini CLI", pkg: "@google/gemini-cli" },
  { kind: "copilot", bin: "copilot", label: "GitHub Copilot CLI", pkg: "@github/copilot" },
];

/** The integrations every repo gets: the commands for Claude Code (.claude/skills) and Codex (.agents/skills). */
const SPECKIT_INTEGRATIONS = ["claude", "codex"] as const;
const speckitScript = () => (process.platform === "win32" ? "ps" : "sh");

/** specify, found on PATH or in uv's tool bin dir (which the login shell may not have on PATH). */
interface Specify {
  bin: string;
  onPath: boolean;
}

/** .specify/integration.json; unreadable or broken counts as no integration yet. */
function readSpeckit(repo: string): { version: string | null; integrations: string[] } {
  try {
    const json = JSON.parse(readFileSync(path.join(repo, ".specify", "integration.json"), "utf8")) as { version?: unknown; installed_integrations?: unknown };
    return {
      version: typeof json.version === "string" ? json.version : null,
      integrations: Array.isArray(json.installed_integrations) ? json.installed_integrations.filter((i): i is string => typeof i === "string") : [],
    };
  } catch {
    return { version: null, integrations: [] };
  }
}

const integrationLabel = (name: string) => AGENT_CLIS.find((c) => c.kind === name)?.label ?? name;

const OUTPUT_TAIL = 6000;
const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);
const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";
const noNpm = () => tr("setupItem.noNpm");

export const defaultRun: Run = (bin, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    const launch = geminiLaunch(bin, args, env);
    execFile(launch.bin, launch.args, { cwd, env: launch.env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: output || (err ? err.message : "") });
    });
  });

const describeFiles = (files: FileAction[]) =>
  files.map((f) => `${f.action.padEnd(9)} ${f.file}${f.note ? ` · ${f.note}` : ""}`).join("\n");

/** Like an agent CLI's --version: a check that takes longer is stuck (asking for input, waiting on the network). */
const TOOL_CHECK_MS = 15_000;

const notFound = (id: string) => new HiveError("not_found", `Không có mục ${id}.`, { key: "errors.setupItemNotFound", vars: { id } });

/** Why a catalog command cannot run from Setup: it has a placeholder only a run fills in ({worktree}, {repo}). */
function placeholderText(e: ToolEntry, err: unknown): string {
  const vars = err instanceof HiveError ? err.vars : undefined;
  return tr("errors.toolPlaceholder", { id: e.id, placeholder: String(vars?.placeholder ?? "?") });
}

export class Setup {
  readonly #host: SetupHost;
  readonly #run: Run;
  readonly #platform: NodeJS.Platform;
  /** The registry's newest version of each CLI package, and when it was looked up. */
  readonly #latest = new Map<string, { at: number; version: string | null }>();

  constructor(host: SetupHost) {
    this.#host = host;
    this.#run = host.run ?? defaultRun;
    this.#platform = host.platform ?? process.platform;
  }

  /** What installAgents needs to name this machine's shim and pick the launch form of each config. */
  #agentOpts(dryRun = false) {
    return { shim: shimTarget(this.#host.shim), home: this.#host.home, platform: this.#platform, dryRun };
  }

  async status(): Promise<SetupReport> {
    const pathEnv = await this.#host.pathEnv(true);
    const clis = await Promise.all(AGENT_CLIS.map((c) => this.#cli(c, pathEnv)));
    const specify = await this.#findSpecify(pathEnv);
    const tools = await Promise.all(this.#catalogTools().map((e) => this.#tool(e, pathEnv)));
    return {
      machine: [...clis, await this.#specify(specify, pathEnv), this.#shim(pathEnv), ...tools],
      projects: this.#host.projects().map((p) => ({ project: p.name, repo: p.repo, items: this.#projectItems(p, pathEnv, specify) })),
    };
  }

  async item(id: string): Promise<SetupItem> {
    const pathEnv = await this.#host.pathEnv(true);
    if (id === "shim") return this.#shim(pathEnv);
    if (id === "cli:specify") return this.#specify(await this.#findSpecify(pathEnv), pathEnv);
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (cli) return this.#cli(cli, pathEnv);
    if (this.#isTool(id)) return this.#tool(this.#catalogTool(id), pathEnv);
    const { project, part } = this.#split(id);
    const specify = part === "speckit" ? await this.#findSpecify(pathEnv) : null;
    const item = this.#projectItems(project, pathEnv, specify).find((i) => i.id === `${project.name}:${part}`);
    if (!item) throw notFound(id);
    return item;
  }

  async install(id: string): Promise<SetupInstallResult> {
    const pathEnv = await this.#host.pathEnv(true);
    const env = { ...this.#host.env(), PATH: pathEnv };
    let output: string;
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (id === "cli:specify") {
      const argv = this.#speckitInstall();
      const bin = resolveBin(argv[0]!, pathEnv);
      if (!bin) throw this.#noInstaller(argv[0]!);
      output = await this.#runOrThrow(bin, argv, { env, timeoutMs: 15 * 60_000 });
    } else if (this.#isTool(id)) {
      output = await this.#toolInstall(this.#catalogTool(id), pathEnv);
    } else if (cli?.kind === "vibe") {
      const uv = resolveBin("uv", pathEnv);
      if (!uv) throw this.#noInstaller("uv");
      const installed = resolveBin("vibe", pathEnv);
      if (installed && !this.#realpath(installed).replaceAll("\\", "/").includes("/uv/tools/mistral-vibe/")) {
        throw new HiveError("bad_request", tr("setupItem.vibeManual"), { key: "setupItem.vibeManual" });
      }
      const busy = this.#host.cliBusy?.("vibe") ?? 0;
      if (busy) throw new HiveError("conflict", tr("setupItem.cliBusy", { label: cli.label, count: busy }), { key: "setupItem.cliBusy", vars: { label: cli.label, count: busy } });
      this.#host.holdCli?.("vibe", true);
      try {
        output = await this.#runOrThrow(uv, ["uv", "tool", "install", "--python", "3.12", ...(installed ? ["--force"] : []), `mistral-vibe==${VIBE_VERSION}`], { env, timeoutMs: 15 * 60_000 });
      } finally { this.#host.holdCli?.("vibe", false); }
    } else if (cli?.kind === "antigravity") {
      throw new HiveError("bad_request", tr("setupItem.agyInstallManual"), { key: "setupItem.agyInstallManual" });
    } else if (cli && resolveBin(cli.bin, pathEnv)) {
      output = await this.#upgrade(cli, pathEnv, env);
    } else if (cli) {
      const npm = resolveBin("npm", pathEnv);
      if (!npm) throw new HiveError("bad_request", noNpm(), { key: "setupItem.noNpm" });
      const args = ["install", "-g", cli.kind === "kilo" ? `${cli.pkg}@7.8.3` : cli.pkg, ...(await this.#npmPrefixArgs(npm, env))];
      const r = await this.#run(npm, args, { env, timeoutMs: 15 * 60_000 });
      if (!r.ok) {
        const output = tail(r.output);
        throw new HiveError("bad_request", `npm install -g ${cli.pkg} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: `npm install -g ${cli.pkg}`, output } });
      }
      output = tail(r.output);
    } else if (id === "shim") {
      const r = installShim(this.#host.shim, pathEnv);
      output = [tr("setupItem.installedAt", { path: r.path }), this.#addShimToPath(pathEnv)].filter(Boolean).join("\n");
    } else {
      const { project, part } = this.#split(id);
      if (part === "agents") output = describeFiles(installAgents(project.repo, project.name, this.#agentOpts()));
      else if (part === "codegraph-mcp") output = describeFiles([installCodegraphMcp(project.repo)]);
      else if (part === "superpowers") output = describeFiles([enableSuperpowers(project.repo)]);
      else if (part === "codegraph-index") output = await this.#codegraphIndex(project, pathEnv, env);
      else if (part === "speckit") output = await this.#speckitRepoInstall(project, await this.#findSpecify(pathEnv), env);
      else throw notFound(id);
    }
    return { item: await this.item(id), output };
  }

  #home(): string {
    return this.#host.home ?? os.homedir();
  }

  /**
   * `--prefix ~/.local` when npm's global prefix is one this user cannot write: without sudo, `npm install -g` there
   * fails with EACCES, and the app never asks for root. Windows' prefix is the user's own %AppData%\npm.
   */
  async #npmPrefixArgs(npm: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    if (this.#platform === "win32") return [];
    const r = await this.#run(npm, ["prefix", "-g"], { env, timeoutMs: 15_000 });
    const prefix = r.ok ? r.output.trim().split("\n").pop()!.trim() : "";
    if (!path.isAbsolute(prefix)) return [];
    // A Node unpacked next to the Linux app is writable, but what goes there goes away with the app (linux-tools.ts).
    if (insideRuntime(prefix, this.#host.runtimeRoots?.() ?? [])) return ["--prefix", userNpmPrefix(this.#home())];
    const writable = this.#host.writable ?? canWrite;
    return writable(path.join(prefix, "lib", "node_modules")) ? [] : ["--prefix", userNpmPrefix(this.#home())];
  }

  /** Runs `argv` (argv[0] already resolved to `bin`): the output's tail, or an error that carries it. */
  async #runOrThrow(bin: string, argv: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
    const r = await this.#run(bin, argv.slice(1), opts);
    const output = tail(r.output);
    if (!r.ok) {
      const command = argv.join(" ");
      throw new HiveError("bad_request", `${command} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command, output } });
    }
    return output;
  }

  #noInstaller(bin: string): HiveError {
    return bin === "uv"
      ? new HiveError("bad_request", tr("setupItem.specifyNoUv"), { key: "setupItem.specifyNoUv" })
      : new HiveError("bad_request", tr("setupItem.toolNoBin", { bin }), { key: "setupItem.toolNoBin", vars: { bin } });
  }

  // ── hub tools (roadmap 28b-2) ──────────────────────────────────────────────

  #trusted(e: ToolEntry): boolean {
    const allowed = trustOf(e, this.#host.toolTrust?.() ?? {});
    return allowed === "app" || allowed === "trusted";
  }

  /**
   * The hub tools that are the machine's own tool:<id> items: no code of their own in the app (a seed keeps its old
   * items), a check to tell whether they are there, and on for one of this machine's projects. Hooks too (28d): their
   * item also says whether the version is the one the catalog pins, which a run needs to use them.
   */
  #catalogTools(): ToolEntry[] {
    const catalog = this.#host.tools?.() ?? null;
    if (!catalog) return [];
    const projects = this.#host.projects();
    // No repo features: they only turn a seed on the old way, and seeds are left out here.
    return catalog.entries.filter((e) => !e.handler && e.check && projects.some((p) => toolOn(e, catalog.projects[p.name], NO_FEATURES)));
  }

  /** tool:<id>, unless it is a repo item of a project named "tool" (tool:agents…), which was there first. */
  #isTool(id: string): boolean {
    if (!id.startsWith("tool:")) return false;
    const part = id.slice("tool:".length);
    return !((POLICY_REPO_PARTS as readonly string[]).includes(part) && this.#host.projects().some((p) => p.name === "tool"));
  }

  #catalogTool(id: string): ToolEntry {
    const e = this.#catalogTools().find((x) => `tool:${x.id}` === id);
    if (!e) throw notFound(id);
    return e;
  }

  /** The tool's fixed variables (no run here, so none that needs {runDir}), never over the PATH the app found for it. */
  #toolEnv(e: ToolEntry, pathEnv: string): NodeJS.ProcessEnv {
    return { ...this.#host.env(), ...toolEnv(e), PATH: pathEnv };
  }

  /** None of the tool's commands runs, not even its check, until this machine's user allowed them as they are now. */
  async #tool(e: ToolEntry, pathEnv: string): Promise<SetupItem> {
    const base = { id: `tool:${e.id}`, label: e.name };
    if (!this.#trusted(e)) return { ...base, state: "manual", detail: tr("setupItem.toolUntrusted"), action: null };
    let check: string[];
    let install: string[] | null;
    try {
      check = toolArgv(e.check!, e);
      install = e.install ? toolArgv(e.install, e) : null;
    } catch (err) {
      return { ...base, state: "manual", detail: placeholderText(e, err), action: null };
    }
    const missing: SetupItem = install
      ? { ...base, state: "missing", detail: tr("setupItem.toolMissing", { command: install.join(" ") }), action: tr("setupItem.install") }
      : { ...base, state: "missing", detail: tr("setupItem.toolNoInstall"), action: null };
    const bin = resolveBin(check[0]!, pathEnv);
    if (!bin) return missing;
    const started = Date.now();
    const r = await this.#run(bin, check.slice(1), { env: this.#toolEnv(e, pathEnv), timeoutMs: TOOL_CHECK_MS });
    // A hook rewrites what the agent runs: only the version the hub approved counts (brew installs whatever it has).
    if (r.ok && e.kind === "hook" && e.package && !versionMatches(r.output, e.package.version)) {
      return { ...base, state: "outdated", detail: tr("setupItem.toolOutdated", { found: versionIn(r.output) ?? (firstLine(r.output) || "?"), version: e.package.version }), action: null };
    }
    if (r.ok) return { ...base, state: "installed", detail: `${firstLine(r.output) || check.join(" ")} · ${bin}`, action: null };
    // Killed by the timeout says nothing about whether the tool is there: the person looks.
    if (Date.now() - started >= TOOL_CHECK_MS) return { ...base, state: "manual", detail: tr("setupItem.toolCheckSlow", { command: check.join(" ") }), action: null };
    return missing;
  }

  async #toolInstall(e: ToolEntry, pathEnv: string): Promise<string> {
    // Also for an admin's request the user approved: approving the request is not allowing the tool's commands.
    if (!this.#trusted(e)) throw new HiveError("bad_request", tr("setupItem.toolUntrusted"), { key: "setupItem.toolUntrusted" });
    if (!e.install) throw new HiveError("bad_request", tr("setupItem.toolNoInstall"), { key: "setupItem.toolNoInstall" });
    const argv = toolArgv(e.install, e);
    const bin = resolveBin(argv[0]!, pathEnv);
    if (!bin) throw this.#noInstaller(argv[0]!);
    return this.#runOrThrow(bin, argv, { env: this.#toolEnv(e, pathEnv), timeoutMs: 15 * 60_000 });
  }

  /**
   * How specify-cli is installed: the catalog's Spec Kit, pinned there, when this machine runs it as it is (the app's
   * own commands, or ones its user allowed); otherwise the app's own pin. Never an unpinned spec-kit from git.
   */
  #speckitInstall(): string[] {
    const own = toolArgv(APP_TOOLS.speckit.install!, APP_TOOLS.speckit);
    const e = this.#host.tools?.()?.entries.find((x) => x.handler === "speckit");
    if (!e?.install || !this.#trusted(e)) return own;
    try {
      return toolArgv(e.install, e);
    } catch {
      return own;
    }
  }

  // ── items ──────────────────────────────────────────────────────────────────

  async #cli(cli: (typeof AGENT_CLIS)[number], pathEnv: string): Promise<SetupItem> {
    const base = { id: `cli:${cli.kind}`, label: cli.label };
    const bin = resolveBin(cli.bin, pathEnv);
    if (cli.kind === "vibe") {
      const uv = resolveBin("uv", pathEnv);
      if (!bin) return { ...base, state: "missing", detail: tr("setupItem.vibeInstall"), action: uv ? tr("setupItem.vibeInstallAction") : null };
      const v = await this.#run(bin, ["--version"], { env: { ...this.#host.env(), PATH: pathEnv }, timeoutMs: 15_000 });
      const version = v.ok ? parseCliVersion(v.output) : null;
      const managed = this.#realpath(bin).replaceAll("\\", "/").includes("/uv/tools/mistral-vibe/");
      return { ...base, state: "installed", version, latest: VIBE_VERSION,
        detail: `${firstLine(v.output)} · ${bin} · ${tr("setupItem.vibeInstall")}`,
        action: version && compareVersions(version, VIBE_VERSION) < 0 && uv && managed ? tr("setupItem.upgradeTo", { version: VIBE_VERSION }) : null };
    }
    if (!bin && cli.kind === "antigravity") return { ...base, state: "missing", detail: tr("setupItem.agyInstallManual"), action: null };
    if (!bin) {
      const npm = resolveBin("npm", pathEnv);
      return {
        ...base,
        state: "missing",
        detail: (npm ? tr("setupItem.cliMissing", { pkg: cli.pkg }) : `${tr("setupItem.notInstalled")} ${noNpm()}`) + (cli.kind === "opencode" ? ` ${tr("setupItem.opencodeInstall")}` : ""),
        action: npm ? tr("setupItem.installNpm") : null,
      };
    }
    const env = { ...this.#host.env(), PATH: pathEnv };
    const v = await this.#run(bin, ["--version"], { env, timeoutMs: 15_000 });
    if (!v.ok) return { ...base, state: "installed", detail: tr("setupItem.versionFailed", { bin, output: firstLine(v.output) }), action: null, version: null, latest: null };
    const version = parseCliVersion(v.output);
    const latest = await this.#latestOf(cli.pkg, pathEnv, env);
    if (cli.kind === "antigravity") return {
      ...base, state: "installed", version, latest, action: null,
      detail: `${firstLine(v.output)} · ${bin} · ${!supportsAgyUsage(v.output) ? tr("setupItem.agyUsageOld") : ""} ${tr("setupItem.agyInstallManual")}`.trim(),
    };
    // A CLI behind the registry still runs: it stays "installed", so a required one is not reported missing.
    if (!version || !latest || compareVersions(latest, version) <= 0) {
      return { ...base, state: "installed", detail: `${firstLine(v.output) || "?"} · ${bin}`, action: null, version, latest };
    }
    const upgrade = cliUpgrade(cli, this.#realpath(bin), bin, this.#home());
    return {
      ...base,
      state: "installed",
      detail: upgrade ? tr("setupItem.cliOutdated", { version, latest, path: bin }) : tr("setupItem.cliOutdatedManual", { version, latest, path: bin }),
      action: upgrade ? tr("setupItem.upgradeTo", { version: latest }) : null,
      version,
      latest,
    };
  }

  /** Upgrades an installed CLI the way it was installed (roadmap 33), while no run uses it and none starts. */
  async #upgrade(cli: (typeof AGENT_CLIS)[number], pathEnv: string, env: NodeJS.ProcessEnv): Promise<string> {
    const own = resolveBin(cli.bin, pathEnv)!;
    const upgrade = cliUpgrade(cli, this.#realpath(own), own, this.#home());
    if (!upgrade) throw new HiveError("bad_request", tr("setupItem.upgradeUnknown", { label: cli.label, pkg: cli.pkg }), { key: "setupItem.upgradeUnknown", vars: { label: cli.label, pkg: cli.pkg } });
    const busy = this.#host.cliBusy?.(cli.kind) ?? 0;
    if (busy) throw new HiveError("conflict", tr("setupItem.cliBusy", { label: cli.label, count: busy }), { key: "setupItem.cliBusy", vars: { label: cli.label, count: busy } });
    const bin = upgrade.bin === own ? own : resolveBin(upgrade.bin, pathEnv);
    if (!bin) throw new HiveError("bad_request", upgrade.bin === "npm" ? noNpm() : tr("setupItem.upgradeUnknown", { label: cli.label, pkg: cli.pkg }), { key: upgrade.bin === "npm" ? "setupItem.noNpm" : "setupItem.upgradeUnknown", vars: { label: cli.label, pkg: cli.pkg } });
    const command = `${upgrade.bin === own ? cli.bin : upgrade.bin} ${upgrade.args.join(" ")}`;
    this.#host.holdCli?.(cli.kind, true);
    try {
      const r = await this.#run(bin, upgrade.args, { env, timeoutMs: 15 * 60_000 });
      if (!r.ok) {
        const output = tail(r.output);
        throw new HiveError("bad_request", `${command} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command, output } });
      }
      // Looked up again next time: what was newest may have been what just got installed, or older.
      this.#latest.delete(cli.pkg);
      return tail(r.output);
    } finally {
      this.#host.holdCli?.(cli.kind, false);
    }
  }

  #realpath(bin: string): string {
    try {
      return this.#host.realpath ? this.#host.realpath(bin) : realpathSync(bin);
    } catch {
      return bin;
    }
  }

  async #latestOf(pkg: string, pathEnv: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    const now = Date.now();
    const cached = this.#latest.get(pkg);
    if (cached && now - cached.at < (cached.version ? LATEST_TTL_MS : LATEST_RETRY_MS)) return cached.version;
    const npm = resolveBin("npm", pathEnv);
    const version = await (this.#host.latest ? this.#host.latest(pkg, npm, env) : npmLatest(this.#run, pkg, npm, env)).catch(() => null);
    this.#latest.set(pkg, { at: now, version });
    return version;
  }

  async #findSpecify(pathEnv: string): Promise<Specify | null> {
    const onPath = resolveBin("specify", pathEnv);
    if (onPath) return { bin: onPath, onPath: true };
    const uv = resolveBin("uv", pathEnv);
    if (!uv) return null;
    // uv puts tool executables in its own bin dir, which a login shell often lacks on PATH: the app calls specify by full path.
    const dir = await this.#run(uv, ["tool", "dir", "--bin"], { env: { ...this.#host.env(), PATH: pathEnv }, timeoutMs: 15_000 });
    const binDir = dir.ok ? firstLine(dir.output) : "";
    const bin = binDir ? resolveBin("specify", binDir) : null;
    return bin ? { bin, onPath: false } : null;
  }

  async #specify(specify: Specify | null, pathEnv: string): Promise<SetupItem> {
    const base = { id: "cli:specify", label: tr("setupItem.specify") };
    if (!specify) {
      const argv = this.#speckitInstall();
      if (resolveBin(argv[0]!, pathEnv)) {
        return { ...base, state: "missing", detail: tr("setupItem.specifyMissing", { command: argv.join(" ") }), action: tr("setupItem.installUv") };
      }
      const why = argv[0] === "uv" ? tr("setupItem.specifyNoUv") : tr("setupItem.toolNoBin", { bin: argv[0]! });
      return { ...base, state: "manual", detail: why, action: null };
    }
    const v = await this.#run(specify.bin, ["--version"], { env: { ...this.#host.env(), PATH: pathEnv }, timeoutMs: 15_000 });
    const where = specify.onPath ? specify.bin : `${specify.bin} · ${tr("setupItem.specifyOffPath")}`;
    return {
      ...base,
      state: "installed",
      detail: v.ok ? `${firstLine(v.output) || "?"} · ${where}` : tr("setupItem.versionFailed", { bin: where, output: firstLine(v.output) }),
      action: null,
    };
  }

  #shim(pathEnv: string): SetupItem {
    const s = shimStatus(this.#host.shim, pathEnv);
    const base = { id: "shim", label: tr("setupItem.shim") };
    const windows = this.#platform === "win32";
    // Windows: what the registry holds counts too. The app's own PATH only changes when it is started again,
    // so right after "Add to PATH" the item would otherwise still say the folder is missing from PATH.
    const onPath = s.onPath || (windows && pathHasDir(this.#userPath(), s.dir));
    if (s.foreign) return { ...base, state: "manual", detail: tr("setupItem.shimForeign", { path: s.path }), action: null };
    if (s.state === "missing") return { ...base, state: "missing", detail: tr("setupItem.shimMissing"), action: tr("setupItem.install") };
    if (s.state === "outdated") return { ...base, state: "outdated", detail: tr("setupItem.shimOutdated", { path: s.path }), action: tr("setupItem.reinstall") };
    if (!onPath) {
      const vars = { path: s.path, dir: s.dir };
      return windows
        ? { ...base, state: "manual", detail: tr("setupItem.shimNotOnPathWindows", vars), action: this.#host.registry ? tr("setupItem.addToPath") : null }
        : { ...base, state: "manual", detail: tr("setupItem.shimNotOnPath", vars), action: null };
    }
    return { ...base, state: "installed", detail: s.path, action: null };
  }

  #userPath(): string | null {
    try {
      return this.#host.registry?.read()?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Windows: puts the shim folder on the user's Path, so agents started from Explorer find hive-mcp. "" elsewhere. */
  #addShimToPath(pathEnv: string): string {
    const reg = this.#host.registry;
    if (this.#platform !== "win32" || !reg) return "";
    const { dir } = shimStatus(this.#host.shim, pathEnv);
    // Already-open programs keep the PATH they started with, Claude Code and its terminal included: the message says so.
    return addToUserPath(reg, dir).added ? tr("setupItem.pathAdded", { dir }) : tr("setupItem.pathAlready", { dir });
  }

  #projectItems(project: DesktopProject, pathEnv: string, specify: Specify | null): SetupItem[] {
    const id = (part: string) => `${project.name}:${part}`;
    const agentsLabel = tr("setupPart.agents");
    if (!existsSync(project.repo)) {
      return [{ id: id("agents"), label: agentsLabel, state: "manual", detail: tr("errors.noFolder", { path: project.repo }), action: null }];
    }
    const plan = installAgents(project.repo, project.name, this.#agentOpts(true));
    // "removed" too: a leftover xdev-hive in .mcp.json still has to go, or the repo keeps a server that cannot start.
    const changes = plan.filter((f) => f.action === "created" || f.action === "updated" || f.action === "removed");
    const manual = plan.filter((f) => f.action === "skipped");
    const agents: SetupItem = changes.length
      ? { id: id("agents"), label: agentsLabel, state: "missing", detail: tr("setupItem.agentsWrites", { files: changes.map((f) => f.file).join(", ") }), action: tr("setupItem.installAgents") }
      : manual.length
        ? { id: id("agents"), label: agentsLabel, state: "manual", detail: manual.map((f) => `${f.file}: ${f.note}`).join(" · "), action: null }
        : { id: id("agents"), label: agentsLabel, state: "installed", detail: tr("setupItem.agentsOk"), action: null };

    const mcp = installCodegraphMcp(project.repo, { dryRun: true });
    const mcpLabel = tr("setupPart.codegraph-mcp");
    const codegraphMcp: SetupItem =
      mcp.action === "unchanged"
        ? { id: id("codegraph-mcp"), label: mcpLabel, state: "installed", detail: tr("setupItem.mcpOk"), action: null }
        : mcp.action === "skipped"
          ? { id: id("codegraph-mcp"), label: mcpLabel, state: "manual", detail: `.mcp.json: ${mcp.note}`, action: null }
          : { id: id("codegraph-mcp"), label: mcpLabel, state: "missing", detail: tr("setupItem.mcpMissing", { pkg: CODEGRAPH_PACKAGE }), action: tr("setupItem.addToMcp") };

    const db = path.join(project.repo, ".codegraph", "codegraph.db");
    const npx = resolveBin("npx", pathEnv);
    const index: SetupItem = existsSync(db)
      ? {
          id: id("codegraph-index"),
          label: tr("setupPart.codegraph-index"),
          state: "installed",
          detail: tr("setupItem.indexOk", { size: (statSync(db).size / 1_048_576).toFixed(1) }),
          action: null,
        }
      : {
          id: id("codegraph-index"),
          label: tr("setupPart.codegraph-index"),
          state: "missing",
          detail: npx ? tr("setupItem.indexMissing") : `${tr("setupItem.notCreated")} ${noNpm()}`,
          action: npx ? tr("setupItem.createIndex") : null,
        };

    const sp = enableSuperpowers(project.repo, { dryRun: true });
    const spLabel = tr("setupItem.superpowers");
    const superpowers: SetupItem =
      sp.action === "unchanged"
        ? { id: id("superpowers"), label: spLabel, state: "installed", detail: tr("setupItem.superpowersOk"), action: null }
        : sp.action === "skipped"
          ? { id: id("superpowers"), label: spLabel, state: "manual", detail: `.claude/settings.json: ${sp.note}`, action: null }
          : { id: id("superpowers"), label: spLabel, state: "missing", detail: tr("setupItem.superpowersOff"), action: tr("setupItem.enable") };

    return [agents, codegraphMcp, index, superpowers, this.#speckit(project, specify)];
  }

  #speckit(project: DesktopProject, specify: Specify | null): SetupItem {
    const base = { id: `${project.name}:speckit`, label: tr("setupPart.speckit") };
    const initialized = existsSync(path.join(project.repo, ".specify"));
    const { version, integrations } = readSpeckit(project.repo);
    const lacking = SPECKIT_INTEGRATIONS.filter((i) => !integrations.includes(i));
    if (initialized && !lacking.length) {
      return { ...base, state: "installed", detail: tr("setupItem.speckitOk", { version: version ?? "?", integrations: integrations.join(", ") }), action: null };
    }
    if (!specify) return { ...base, state: "missing", detail: tr("setupItem.speckitNoCli"), action: null };
    if (!initialized) return { ...base, state: "missing", detail: tr("setupItem.speckitMissing"), action: tr("setupItem.installSpeckit") };
    const names = lacking.map(integrationLabel).join(", ");
    return { ...base, state: "missing", detail: tr("setupItem.speckitLacks", { names }), action: tr("setupItem.addSpeckitCommands", { names }) };
  }

  async #speckitRepoInstall(project: DesktopProject, specify: Specify | null, env: NodeJS.ProcessEnv): Promise<string> {
    if (!specify) throw new HiveError("bad_request", tr("setupItem.speckitNoCli"), { key: "setupItem.speckitNoCli" });
    const script = speckitScript();
    const steps: string[][] = [];
    // Never init again over an existing .specify/: --force would overwrite it, constitution included.
    if (!existsSync(path.join(project.repo, ".specify"))) {
      // --non-interactive: without it specify asks which agent to use and hangs with no TTY.
      steps.push(["init", "--here", "--force", "--non-interactive", "--integration", "claude", "--script", script, "--ignore-agent-tools"]);
      for (const name of SPECKIT_INTEGRATIONS) if (name !== "claude") steps.push(["integration", "install", name, "--script", script]);
    } else {
      const { integrations } = readSpeckit(project.repo);
      for (const name of SPECKIT_INTEGRATIONS) if (!integrations.includes(name)) steps.push(["integration", "install", name, "--script", script]);
    }
    const outputs: string[] = [];
    for (const args of steps) {
      const r = await this.#run(specify.bin, args, { cwd: project.repo, env, timeoutMs: 10 * 60_000 });
      if (!r.ok) {
        const output = tail(r.output);
        throw new HiveError("bad_request", `specify ${args.join(" ")} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: `specify ${args.join(" ")}`, output } });
      }
      outputs.push(r.output);
    }
    return tail([...outputs, tr("setupItem.speckitCommit")].join("\n").trim());
  }

  async #codegraphIndex(project: DesktopProject, pathEnv: string, env: NodeJS.ProcessEnv): Promise<string> {
    const npx = resolveBin("npx", pathEnv);
    if (!npx) throw new HiveError("bad_request", noNpm(), { key: "setupItem.noNpm" });
    const opts = { cwd: project.repo, env: { ...env, CODEGRAPH_TELEMETRY: "0" }, timeoutMs: 20 * 60_000 };
    // Opt this machine out first: codegraph sends anonymous usage stats by default.
    const off = await this.#run(npx, ["-y", CODEGRAPH_PACKAGE, "telemetry", "off"], opts);
    if (!off.ok) {
      const output = tail(off.output);
      throw new HiveError("bad_request", `codegraph telemetry off lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: "codegraph telemetry off", output } });
    }
    const init = await this.#run(npx, ["-y", CODEGRAPH_PACKAGE, "init"], opts);
    if (!init.ok) {
      const output = tail(init.output);
      throw new HiveError("bad_request", `codegraph init lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: "codegraph init", output } });
    }
    return tail(`${off.output}\n${init.output}`.trim());
  }

  #split(id: string): { project: DesktopProject; part: string } {
    const at = id.lastIndexOf(":");
    const name = id.slice(0, at);
    const project = this.#host.projects().find((p) => p.name === name);
    if (at < 1 || !project) throw notFound(id);
    return { project, part: id.slice(at + 1) };
  }
}
