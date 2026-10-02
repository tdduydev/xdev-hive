// What is installed on this machine (agent CLIs, Spec Kit's specify, the hive-mcp shim) and in each project
// repo (Hive's agent config, codegraph, superpowers, Spec Kit), and how to install what is missing.
// No Electron imports: the main process provides a SetupHost, tests provide a fake one.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HiveError, type AgentKind, type DesktopProject, type FileAction, type SetupInstallResult, type SetupItem, type SetupReport } from "@xdev-hive/core";
import {
  CODEGRAPH_PACKAGE,
  enableSuperpowers,
  installAgents,
  installCodegraphMcp,
  installShim,
  shimStatus,
  type ShimOptions,
} from "./installer.ts";
import { tr } from "./i18n.ts";
import { resolveBin } from "./runner/command.ts";

export interface RunResult {
  ok: boolean;
  output: string;
}

export type Run = (bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

export interface SetupHost {
  /** Login-shell PATH; refresh=true after an install may have changed it. */
  pathEnv(refresh?: boolean): string;
  /** Base env for child processes (already carries pathEnv). */
  env(): NodeJS.ProcessEnv;
  projects(): DesktopProject[];
  shim: ShimOptions;
  /** For ~/.codex/config.toml in the agent config check. */
  home?: string;
  run?: Run;
}

/** The CLIs the default profiles use, and the npm package that provides each. */
export const AGENT_CLIS: Array<{ kind: Exclude<AgentKind, "custom">; bin: string; label: string; pkg: string }> = [
  { kind: "claude", bin: "claude", label: "Claude Code", pkg: "@anthropic-ai/claude-code" },
  { kind: "codex", bin: "codex", label: "Codex CLI", pkg: "@openai/codex" },
  { kind: "gemini", bin: "gemini", label: "Gemini CLI", pkg: "@google/gemini-cli" },
];

/** Where `uv tool install` takes specify-cli from (github/spec-kit, docs/specs/20-speckit.md). */
export const SPECKIT_SOURCE = "git+https://github.com/github/spec-kit.git";
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
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: output || (err ? err.message : "") });
    });
  });

const describeFiles = (files: FileAction[]) =>
  files.map((f) => `${f.action.padEnd(9)} ${f.file}${f.note ? ` · ${f.note}` : ""}`).join("\n");

export class Setup {
  readonly #host: SetupHost;
  readonly #run: Run;

  constructor(host: SetupHost) {
    this.#host = host;
    this.#run = host.run ?? defaultRun;
  }

  async status(): Promise<SetupReport> {
    const pathEnv = this.#host.pathEnv(true);
    const clis = await Promise.all(AGENT_CLIS.map((c) => this.#cli(c, pathEnv)));
    const specify = await this.#findSpecify(pathEnv);
    return {
      machine: [...clis, await this.#specify(specify, pathEnv), this.#shim(pathEnv)],
      projects: this.#host.projects().map((p) => ({ project: p.name, repo: p.repo, items: this.#projectItems(p, pathEnv, specify) })),
    };
  }

  async item(id: string): Promise<SetupItem> {
    const pathEnv = this.#host.pathEnv(true);
    if (id === "shim") return this.#shim(pathEnv);
    if (id === "cli:specify") return this.#specify(await this.#findSpecify(pathEnv), pathEnv);
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (cli) return this.#cli(cli, pathEnv);
    const { project, part } = this.#split(id);
    const specify = part === "speckit" ? await this.#findSpecify(pathEnv) : null;
    const item = this.#projectItems(project, pathEnv, specify).find((i) => i.id === `${project.name}:${part}`);
    if (!item) throw new HiveError("not_found", `Không có mục ${id}.`, { key: "errors.setupItemNotFound", vars: { id } });
    return item;
  }

  async install(id: string): Promise<SetupInstallResult> {
    const pathEnv = this.#host.pathEnv(true);
    const env = { ...this.#host.env(), PATH: pathEnv };
    let output: string;
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (id === "cli:specify") {
      const uv = resolveBin("uv", pathEnv);
      if (!uv) throw new HiveError("bad_request", tr("setupItem.specifyNoUv"), { key: "setupItem.specifyNoUv" });
      const args = ["tool", "install", "specify-cli", "--from", SPECKIT_SOURCE];
      const r = await this.#run(uv, args, { env, timeoutMs: 15 * 60_000 });
      if (!r.ok) {
        const output = tail(r.output);
        throw new HiveError("bad_request", `uv ${args.join(" ")} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: `uv ${args.join(" ")}`, output } });
      }
      output = tail(r.output);
    } else if (cli) {
      const npm = resolveBin("npm", pathEnv);
      if (!npm) throw new HiveError("bad_request", noNpm(), { key: "setupItem.noNpm" });
      const r = await this.#run(npm, ["install", "-g", cli.pkg], { env, timeoutMs: 15 * 60_000 });
      if (!r.ok) {
        const output = tail(r.output);
        throw new HiveError("bad_request", `npm install -g ${cli.pkg} lỗi:\n${output}`, { key: "errors.commandFailed", vars: { command: `npm install -g ${cli.pkg}`, output } });
      }
      output = tail(r.output);
    } else if (id === "shim") {
      const r = installShim(this.#host.shim, pathEnv);
      output = tr("setupItem.installedAt", { path: r.path });
    } else {
      const { project, part } = this.#split(id);
      if (part === "agents") output = describeFiles(installAgents(project.repo, project.name, { home: this.#host.home }));
      else if (part === "codegraph-mcp") output = describeFiles([installCodegraphMcp(project.repo)]);
      else if (part === "superpowers") output = describeFiles([enableSuperpowers(project.repo)]);
      else if (part === "codegraph-index") output = await this.#codegraphIndex(project, pathEnv, env);
      else if (part === "speckit") output = await this.#speckitInstall(project, await this.#findSpecify(pathEnv), env);
      else throw new HiveError("not_found", `Không có mục ${id}.`, { key: "errors.setupItemNotFound", vars: { id } });
    }
    return { item: await this.item(id), output };
  }

  // ── items ──────────────────────────────────────────────────────────────────

  async #cli(cli: (typeof AGENT_CLIS)[number], pathEnv: string): Promise<SetupItem> {
    const base = { id: `cli:${cli.kind}`, label: cli.label };
    const bin = resolveBin(cli.bin, pathEnv);
    if (!bin) {
      const npm = resolveBin("npm", pathEnv);
      return {
        ...base,
        state: "missing",
        detail: npm ? tr("setupItem.cliMissing", { pkg: cli.pkg }) : `${tr("setupItem.notInstalled")} ${noNpm()}`,
        action: npm ? tr("setupItem.installNpm") : null,
      };
    }
    const v = await this.#run(bin, ["--version"], { env: { ...this.#host.env(), PATH: pathEnv }, timeoutMs: 15_000 });
    return {
      ...base,
      state: "installed",
      detail: v.ok ? `${firstLine(v.output) || "?"} · ${bin}` : tr("setupItem.versionFailed", { bin, output: firstLine(v.output) }),
      action: null,
    };
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
      return resolveBin("uv", pathEnv)
        ? { ...base, state: "missing", detail: tr("setupItem.specifyMissing", { source: SPECKIT_SOURCE }), action: tr("setupItem.installUv") }
        : { ...base, state: "manual", detail: tr("setupItem.specifyNoUv"), action: null };
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
    const dir = path.dirname(s.path);
    if (s.foreign) return { ...base, state: "manual", detail: tr("setupItem.shimForeign", { path: s.path }), action: null };
    if (s.state === "missing") return { ...base, state: "missing", detail: tr("setupItem.shimMissing"), action: tr("setupItem.install") };
    if (s.state === "outdated") return { ...base, state: "outdated", detail: tr("setupItem.shimOutdated", { path: s.path }), action: tr("setupItem.reinstall") };
    if (!s.onPath) {
      return { ...base, state: "manual", detail: tr("setupItem.shimNotOnPath", { path: s.path, dir }), action: null };
    }
    return { ...base, state: "installed", detail: s.path, action: null };
  }

  #projectItems(project: DesktopProject, pathEnv: string, specify: Specify | null): SetupItem[] {
    const id = (part: string) => `${project.name}:${part}`;
    const agentsLabel = tr("setupPart.agents");
    if (!existsSync(project.repo)) {
      return [{ id: id("agents"), label: agentsLabel, state: "manual", detail: tr("errors.noFolder", { path: project.repo }), action: null }];
    }
    const plan = installAgents(project.repo, project.name, { home: this.#host.home, dryRun: true });
    const changes = plan.filter((f) => f.action === "created" || f.action === "updated");
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

  async #speckitInstall(project: DesktopProject, specify: Specify | null, env: NodeJS.ProcessEnv): Promise<string> {
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
    if (at < 1 || !project) throw new HiveError("not_found", `Không có mục ${id}.`, { key: "errors.setupItemNotFound", vars: { id } });
    return { project, part: id.slice(at + 1) };
  }
}
