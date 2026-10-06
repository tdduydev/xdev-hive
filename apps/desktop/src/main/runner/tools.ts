// The hub's tool catalog on this machine (roadmap 28b): which tools a run gets, what Claude Code and Codex are told to
// start, and the step that readies a tool in the worktree (codegraph's index) before the agent starts. Without a
// catalog (local mode, a hub older than 28b) the app's own entries stand in for what the repo's setup turned on.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolArgv, toolEnv, toolHash, versionIn, versionMatches, type AgentKind, type Autonomy, type RunCompression, type AgentPolicy, type MachineToolSetting, type MachineTools, type MachineToolView, type ToolContext, type ToolEntry, type ToolHandler } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";
import type { RepoFeatures } from "#desktop/main/installer.ts";
import { defaultRun, type Run } from "#desktop/main/setup.ts";

/**
 * What the app runs by itself for the seeds, as the 28a migration wrote them (CODEGRAPH_MCP, SUPERPOWERS_PLUGIN, Spec
 * Kit). A catalog entry with the same handler and the same commands counts as allowed: machines that ran these before
 * the catalog keep running them without asking. A newer version on the hub is a change the user allows.
 */
export const APP_TOOLS: Record<ToolHandler, ToolEntry> = {
  codegraph: {
    id: "codegraph",
    name: "Codegraph",
    description: "",
    kind: "mcp",
    package: { registry: "npm", name: "@colbymchenry/codegraph", version: "1.6.0" },
    mcp: { command: "npx", args: ["-y", "{package}", "serve", "--mcp"] },
    plugin: null,
    hooks: [],
    agents: ["claude"],
    check: null,
    install: null,
    prepare: { init: ["npx", "-y", "{package}", "init", "{worktree}"], sync: ["npx", "-y", "{package}", "sync", "{worktree}"], marker: ".codegraph/codegraph.db" },
    env: { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
    secretEnv: [],
    license: "MIT",
    homepage: "https://github.com/colbymchenry/codegraph",
    handler: "codegraph",
    enabledByDefault: false,
  },
  superpowers: {
    id: "superpowers",
    name: "Superpowers",
    description: "",
    kind: "plugin",
    package: { registry: "claude-plugin", name: "superpowers@claude-plugins-official", version: "6.4.2" },
    mcp: null,
    plugin: "superpowers@claude-plugins-official",
    hooks: [],
    agents: ["claude"],
    check: null,
    install: null,
    prepare: null,
    env: {},
    secretEnv: [],
    license: "MIT",
    homepage: "https://github.com/obra/superpowers",
    handler: "superpowers",
    enabledByDefault: false,
  },
  speckit: {
    id: "speckit",
    name: "Spec Kit",
    description: "",
    kind: "cli",
    package: { registry: "git", name: "https://github.com/github/spec-kit.git", version: "v1.0.13" },
    mcp: null,
    plugin: null,
    hooks: [],
    agents: ["claude", "codex"],
    check: ["specify", "--version"],
    install: ["uv", "tool", "install", "specify-cli", "--from", "{package}"],
    prepare: null,
    env: {},
    secretEnv: [],
    license: "MIT",
    homepage: "https://github.com/github/spec-kit",
    handler: "speckit",
    enabledByDefault: false,
  },
};

const APP_HASHES = Object.fromEntries(Object.entries(APP_TOOLS).map(([handler, e]) => [handler, toolHash(e)])) as Record<ToolHandler, string>;

/** What a run gets of the catalog, and the run log's lines on what it left out (names of variables, never values). */
export interface ToolPick {
  /** Started by the agent's CLI (MCP servers, Claude Code plugins). */
  tools: ToolEntry[];
  /** Readied in the worktree first, whatever the CLI: another CLI's own config may start the server (as before 28b). */
  prepare: ToolEntry[];
  notes: string[];
  /** Claude Code hooks (roadmap 28d), still to be checked on this machine (readyHooks); left out when none. */
  hooks?: ToolEntry[];
}

export const NO_TOOLS: ToolPick = { tools: [], prepare: [], notes: [] };

/** What setup turned on in the repo before the catalog: codegraph in .mcp.json, superpowers in .claude/settings.json. */
const legacyOn = (e: ToolEntry, features: RepoFeatures) => (e.handler === "codegraph" && features.codegraph) || (e.handler === "superpowers" && features.superpowers);

/** The app's entries for what the repo's setup turned on: the run as before the catalog. */
export function legacyTools(features: RepoFeatures): ToolEntry[] {
  return [...(features.codegraph ? [APP_TOOLS.codegraph] : []), ...(features.superpowers ? [APP_TOOLS.superpowers] : [])];
}

/** Without a catalog: Claude gets the repo's tools, every CLI the codegraph index (unless the policy leaves it out). */
export function legacyPick(features: RepoFeatures, kind: AgentKind, mcp: string[] | null): ToolPick {
  const codegraph = features.codegraph && (mcp === null || mcp.includes("codegraph"));
  return { tools: kind === "claude" ? legacyTools(features) : [], prepare: codegraph ? [APP_TOOLS.codegraph] : [], notes: [] };
}

/** Whether a project has the tool on: its setting, else the tool's default or, for a seed, the repo's own setup. */
export function toolOn(e: ToolEntry, settings: MachineToolSetting[] | undefined, features: RepoFeatures): boolean {
  const s = settings?.find((x) => x.id === e.id);
  // A project the hub sent no line for (added since the last heartbeat) follows the defaults, as the hub would.
  return s ? s.effective || (s.enabled === null && legacyOn(e, features)) : e.enabledByDefault || legacyOn(e, features);
}

export function trustOf(e: ToolEntry, trust: Record<string, string>): MachineToolView["trust"] {
  const hash = toolHash(e);
  if (e.handler && APP_HASHES[e.handler] === hash) return "app";
  const allowed = trust[e.id];
  return allowed === hash ? "trusted" : allowed ? "changed" : "new";
}

/** Every command of an entry, by field. */
function commandsOf(e: ToolEntry): Array<{ field: string; argv: string[] }> {
  return [
    ...(e.mcp ? [{ field: "mcp", argv: [e.mcp.command, ...e.mcp.args] }] : []),
    ...e.hooks.map((h, i) => ({ field: `hooks.${i}`, argv: h.command })),
    ...(e.check ? [{ field: "check", argv: e.check }] : []),
    ...(e.install ? [{ field: "install", argv: e.install }] : []),
    ...(e.prepare ? [{ field: "prepare.init", argv: e.prepare.init }, { field: "prepare.sync", argv: e.prepare.sync }] : []),
  ];
}

/** Why a run cannot fill in the entry's commands (a `{package}` with no package), or null. */
function argvProblem(e: ToolEntry): string | null {
  const run = [...(e.mcp ? [[e.mcp.command, ...e.mcp.args]] : []), ...e.hooks.map((h) => h.command), ...(e.prepare ? [e.prepare.init, e.prepare.sync] : [])];
  try {
    for (const argv of run) toolArgv(argv, e, { worktree: "/", repo: "/" });
    return null;
  } catch (err) {
    const vars = (err as { vars?: Record<string, string | number> }).vars;
    return tr("errors.toolPlaceholder", { id: e.id, placeholder: String(vars?.placeholder ?? "?") });
  }
}

/**
 * The tools a run of `project` on a `kind` CLI gets: on for the project (or its seed turned on the old way), allowed by
 * the policy (MCP servers), allowed by this machine's user as they are now, and with every secret variable at hand.
 * `env`: the run's own (the machine's and the profile's), read for names only.
 */
export function runTools(
  catalog: MachineTools,
  project: string,
  features: RepoFeatures,
  kind: AgentKind,
  pol: AgentPolicy,
  trust: Record<string, string>,
  env: Record<string, string | undefined>,
): ToolPick {
  const pick: ToolPick = { tools: [], prepare: [], notes: [] };
  for (const e of catalog.entries) {
    // A CLI tool changes nothing in a run. Hooks run in Claude Code's runs only (28d): Codex's would need a file in the
    // worktree, which the agent can edit.
    if (e.kind === "cli" && !e.prepare) continue;
    if (e.kind === "hook" && (kind !== "claude" || !e.agents.includes("claude"))) continue;
    const forCli = (e.agents as string[]).includes(kind);
    if (!forCli && !e.prepare) continue;
    if (!toolOn(e, catalog.projects[project], features)) continue;
    if (e.kind === "mcp" && pol.mcp !== null && !pol.mcp.includes(e.id)) continue;
    const allowed = trustOf(e, trust);
    if (allowed !== "app" && allowed !== "trusted") {
      pick.notes.push(tr("runNote.toolUntrusted", { id: e.id }));
      continue;
    }
    const missing = e.secretEnv.filter((name) => !env[name]);
    if (missing.length) {
      pick.notes.push(tr("runNote.toolMissingEnv", { id: e.id, names: missing.join(", ") }));
      continue;
    }
    const problem = argvProblem(e);
    if (problem) {
      pick.notes.push(`tool ${e.id}: ${problem}`);
      continue;
    }
    if (e.kind === "hook") {
      (pick.hooks ??= []).push(e);
      continue;
    }
    if (forCli && (e.kind === "mcp" || e.kind === "plugin")) pick.tools.push(e);
    if (e.prepare) pick.prepare.push(e);
  }
  return pick;
}

/** A server the run starts ends with its agent: codegraph would otherwise leave a daemon per worktree behind. */
function serverEnv(e: ToolEntry): Record<string, string> {
  return { ...e.env, ...(e.handler === "codegraph" ? { CODEGRAPH_NO_DAEMON: "1" } : {}) };
}

/**
 * Claude Code's entry for an MCP tool. A secret goes in as a reference Claude Code fills in from its own environment
 * (the run's), so its value is never on the command line or in the run log.
 */
export function claudeToolServer(e: ToolEntry, ctx: ToolContext): Record<string, unknown> {
  const [command, ...args] = toolArgv([e.mcp!.command, ...e.mcp!.args], e, ctx);
  return { type: "stdio", command, args, env: { ...serverEnv(e), ...Object.fromEntries(e.secretEnv.map((n) => [n, `\${${n}}`])) } };
}

/** A TOML basic string (JSON's escapes are valid TOML ones). */
const toml = (s: string) => JSON.stringify(s);

/**
 * Codex's -c overrides for the run's MCP tools. A server of the same name in ~/.codex/config.toml is overridden, as it
 * should be. Approved, since headless Codex refuses a tool it would ask about, and the machine's user allowed these.
 * Secrets go by name (env_vars): Codex hands them on from its own environment.
 */
export function codexToolArgs(tools: ToolEntry[], ctx: ToolContext): string[] {
  return tools
    .filter((e) => e.kind === "mcp" && e.mcp)
    .flatMap((e) => {
      const [command, ...args] = toolArgv([e.mcp!.command, ...e.mcp!.args], e, ctx);
      const env = Object.entries(serverEnv(e));
      const key = `mcp_servers.${e.id}`;
      return [
        "-c",
        `${key}.command=${toml(command!)}`,
        "-c",
        `${key}.args=[${args.map(toml).join(",")}]`,
        ...(env.length ? ["-c", `${key}.env={${env.map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`] : []),
        ...(e.secretEnv.length ? ["-c", `${key}.env_vars=[${e.secretEnv.map(toml).join(",")}]`] : []),
        "-c",
        `${key}.default_tools_approval_mode="approve"`,
      ];
    });
}

/**
 * The folders the tools' prepare steps write in the worktree (the marker's first part, e.g. .codegraph), kept out of
 * the agent's commit like AGENT_CLI_DIRS. Never a path out of the worktree.
 */
export function toolDirs(entries: ToolEntry[]): string[] {
  const dirs = entries.flatMap((e) => {
    const marker = e.prepare?.marker.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
    if (!marker || marker.startsWith("/") || /^[A-Za-z]:/.test(marker) || marker.split("/").includes("..")) return [];
    return [marker.split("/")[0]!];
  });
  return [...new Set(dirs)].filter((d) => d && d !== ".");
}

/** Enough for a big repo's first index (this repo's codegraph takes about 3 s); past it the run goes on without. */
const PREPARE_TIMEOUT_MS = 5 * 60_000;

/**
 * Readies a tool in the run's worktree: `prepare.init` when the marker is missing (a fresh checkout: git ignores
 * .codegraph/), `prepare.sync` when it is there (a reused worktree: only what changed). Never throws, since an agent
 * without it still works, with more reading. Returns the line for the run's log.
 */
export async function prepareTool(
  e: ToolEntry,
  worktree: string,
  ctx: { repo?: string },
  resolve: (bin: string) => string | null,
  env: NodeJS.ProcessEnv,
  run: Run = defaultRun,
  now: () => number = Date.now,
): Promise<string> {
  const p = e.prepare!;
  // As the log said before the catalog, for codegraph.
  const without = e.handler === "codegraph" ? "no index for this run" : "not prepared for this run";
  const step = existsSync(path.join(worktree, p.marker)) ? "sync" : "init";
  let argv: string[];
  try {
    argv = toolArgv(p[step], e, { worktree, ...ctx });
  } catch {
    return `# ${e.id}: ${step} failed, ${without}`;
  }
  const bin = resolve(argv[0]!);
  if (!bin) return `# ${e.id}: ${argv[0]} not found, ${without}`;
  const started = now();
  const r = await run(bin, argv.slice(1), {
    cwd: worktree,
    // npm's update notice would otherwise be the last line of a failure.
    env: { ...env, ...e.env, npm_config_update_notifier: "false" },
    timeoutMs: PREPARE_TIMEOUT_MS,
  });
  const took = `${((now() - started) / 1000).toFixed(1)} s`;
  if (r.ok) return `# ${e.id}: ${step} ${took}`;
  const last = r.output.trim().split("\n").at(-1)?.trim() ?? "";
  return `# ${e.id}: ${step} failed after ${took}, ${without}${last ? `: ${last.slice(0, 200)}` : ""}`;
}

/**
 * The Setup card's list: each hub tool one of this machine's projects has on, with the commands it would run here
 * and whether the user allowed them, hooks included (28d): allowing one is what lets it into a run.
 */
export function toolViews(catalog: MachineTools | null, projects: Array<{ name: string; features: RepoFeatures }>, trust: Record<string, string>): MachineToolView[] {
  if (!catalog) return [];
  return catalog.entries.flatMap((e) => {
    const on = projects.filter((p) => toolOn(e, catalog.projects[p.name], p.features)).map((p) => p.name);
    if (!on.length) return [];
    const commands = commandsOf(e).map(({ field, argv }) => {
      try {
        // Per run, so shown as placeholders.
        return { field, argv: toolArgv(argv, e, { worktree: "{worktree}", repo: "{repo}" }) };
      } catch {
        return { field, argv: [...argv] };
      }
    });
    const required = on.filter((p) => catalog.projects[p]?.some((s) => s.id === e.id && s.required));
    return [
      {
        id: e.id,
        name: e.name,
        kind: e.kind,
        license: e.license,
        homepage: e.homepage,
        commands,
        env: e.env,
        secretEnv: e.secretEnv,
        hash: toolHash(e),
        trust: trustOf(e, trust),
        projects: on,
        handler: e.handler,
        required,
      },
    ];
  });
}

// ── hooks (roadmap 28d) ──────────────────────────────────────────────────────

/** A hook entry ready for a run: each of its hooks with the program written as the path found on this machine. */
export interface ReadyHook {
  entry: ToolEntry;
  hooks: Array<{ event: ToolEntry["hooks"][number]["event"]; matcher: string; argv: string[] }>;
}

/** Long enough for a CLI's --version; a check slower than this says nothing either way, and the run goes on without. */
const HOOK_CHECK_MS = 15_000;

/**
 * The run's hooks this machine can run as the hub approved them: only at autonomy full (a hook may answer "allow" for a
 * command a lower level would ask about, from rules in the worktree the agent can edit), never on Windows (untried),
 * each program found on the PATH, and the version the entry pins (brew installs whatever homebrew has). The rest are
 * left out, each with a line for the run's log. `env`: the run's, for the check.
 */
export async function readyHooks(
  hooks: ToolEntry[],
  o: { autonomy: Autonomy; resolve: (bin: string) => string | null; env: NodeJS.ProcessEnv; run?: Run; platform?: NodeJS.Platform },
): Promise<{ ready: ReadyHook[]; notes: string[] }> {
  const ready: ReadyHook[] = [];
  const notes: string[] = [];
  const run = o.run ?? defaultRun;
  for (const e of hooks) {
    if ((o.platform ?? process.platform) === "win32") {
      notes.push(tr("runNote.toolHookWindows", { id: e.id }));
      continue;
    }
    if (o.autonomy !== "full") {
      notes.push(tr("runNote.toolHookAutonomy", { id: e.id }));
      continue;
    }
    if (e.package && e.check) {
      let check: string[];
      try {
        check = toolArgv(e.check, e);
      } catch {
        notes.push(tr("errors.toolPlaceholder", { id: e.id, placeholder: "?" }));
        continue;
      }
      const bin = o.resolve(check[0]!);
      const r = bin ? await run(bin, check.slice(1), { env: { ...o.env, ...toolEnv(e) }, timeoutMs: HOOK_CHECK_MS }) : null;
      if (!r?.ok) {
        notes.push(tr("runNote.toolHookMissing", { id: e.id, bin: check[0]! }));
        continue;
      }
      if (!versionMatches(r.output, e.package.version)) {
        notes.push(tr("runNote.toolHookVersion", { id: e.id, found: versionIn(r.output) ?? "?", version: e.package.version }));
        continue;
      }
    }
    const resolved = e.hooks.map((h) => {
      const argv = toolArgv(h.command, e);
      const bin = o.resolve(argv[0]!);
      return bin ? { event: h.event, matcher: h.matcher, argv: [path.resolve(bin), ...argv.slice(1)] } : argv[0]!;
    });
    const lost = resolved.find((h) => typeof h === "string");
    if (lost !== undefined) {
      notes.push(tr("runNote.toolHookMissing", { id: e.id, bin: lost }));
      continue;
    }
    ready.push({ entry: e, hooks: resolved as ReadyHook["hooks"] });
  }
  return { ready, notes };
}

/** A POSIX shell word: Claude Code runs a hook's command through the shell. */
export function shellQuote(arg: string): string {
  return /^[\w./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Seconds Claude Code waits for a catalog hook: RTK's answers in milliseconds, and a stuck hook must not hold a run. */
export const HOOK_TIMEOUT_S = 10;

export type ClaudeHookSettings = Record<string, Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }>>;

/** The `hooks` of Claude Code's settings for the run. */
export function claudeHooks(ready: ReadyHook[]): ClaudeHookSettings {
  const out: ClaudeHookSettings = {};
  for (const r of ready) {
    for (const h of r.hooks) {
      (out[h.event] ??= []).push({ matcher: h.matcher, hooks: [{ type: "command", command: h.argv.map(shellQuote).join(" "), timeout: HOOK_TIMEOUT_S }] });
    }
  }
  return out;
}

/** The hook entries' variables, `{runDir}` written out: the claude process gets them, so its hooks and Bash commands do. */
export function hookEnv(ready: ReadyHook[], runDir: string): Record<string, string> {
  return Object.assign({}, ...ready.map((r) => toolEnv(r.entry, runDir))) as Record<string, string>;
}

/** What a run with hooks takes from the user's Claude Code settings, which it no longer loads (setting sources ''). */
export interface UserClaudeSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  apiKeyHelper?: string;
  model?: string;
  /** Goes to the claude process's environment, never on its command line or in the run log. */
  env?: Record<string, string>;
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

/**
 * The few keys of the user's settings.json (CLAUDE_CONFIG_DIR's, a 24b account, else ~/.claude's) a run used to get from
 * them and still should: permissions, env, apiKeyHelper, model. Never hooks, disableAllHooks, enabledPlugins (the
 * catalog decides those), statusLine or anything else. A file that cannot be read gives nothing, with a log line.
 */
export function userClaudeSettings(env: Record<string, string | undefined>, home: string = os.homedir()): { settings: UserClaudeSettings; note: string | null } {
  const dirOf = (d: string) => (d === "~" || d.startsWith("~/") ? path.join(home, d.slice(1)) : d);
  const file = path.join(env.CLAUDE_CONFIG_DIR ? dirOf(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude"), "settings.json");
  if (!existsSync(file)) return { settings: {}, note: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { settings: {}, note: tr("runNote.userSettingsUnread", { file, reason: (err as Error).message.split("\n")[0]!.slice(0, 200) }) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings: {}, note: tr("runNote.userSettingsUnread", { file, reason: "not an object" }) };
  const o = raw as Record<string, unknown>;
  const settings: UserClaudeSettings = {};
  const p = o.permissions;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const perm = p as Record<string, unknown>;
    const permissions: NonNullable<UserClaudeSettings["permissions"]> = {};
    for (const k of ["allow", "deny", "ask"] as const) {
      const list = strings(perm[k]);
      if (list?.length) permissions[k] = list;
    }
    if (Object.keys(permissions).length) settings.permissions = permissions;
  }
  if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
    const vars = Object.entries(o.env as Record<string, unknown>).filter((x): x is [string, string] => typeof x[1] === "string");
    if (vars.length) settings.env = Object.fromEntries(vars);
  }
  if (typeof o.apiKeyHelper === "string" && o.apiKeyHelper) settings.apiKeyHelper = o.apiKeyHelper;
  if (typeof o.model === "string" && o.model) settings.model = o.model;
  return { settings, note: null };
}

/** Enough for `rtk gain` on one run's history; past it the run's numbers stay null. */
const GAIN_MS = 10_000;

/**
 * What RTK says it left out of the run (roadmap 28d): `rtk gain --format json` on the run's own history (RTK_DB_PATH in
 * `env`). null when RTK was not in the run, or failed, or took too long. RTK's estimate, not billed tokens.
 */
export async function rtkGain(ready: ReadyHook[], env: NodeJS.ProcessEnv, run: Run = defaultRun): Promise<RunCompression | null> {
  const rtk = ready.find((r) => r.entry.id === "rtk")?.hooks[0];
  if (!rtk) return null;
  const r = await run(rtk.argv[0]!, ["gain", "--format", "json"], { env, timeoutMs: GAIN_MS });
  if (!r.ok) return null;
  try {
    // Only the JSON: a warning RTK prints before it must not lose the numbers.
    const json = r.output.slice(r.output.indexOf("{"), r.output.lastIndexOf("}") + 1);
    const s = (JSON.parse(json) as { summary?: Record<string, unknown> }).summary;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    const out = { commands: n(s?.total_commands), input: n(s?.total_input), output: n(s?.total_output), saved: n(s?.total_saved) };
    if (Object.values(out).some((v) => v === null)) return null;
    return { tool: "rtk", ...(out as Omit<RunCompression, "tool">) };
  } catch {
    return null;
  }
}
