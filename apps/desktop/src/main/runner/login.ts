// Whether each profile's CLI is signed in, asked from the CLI itself with the profile's env, so a
// second login dir (CLAUDE_CONFIG_DIR, CODEX_HOME) is checked on its own. No Electron imports.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { HiveError, type AgentKind, type AgentProfile, type LoginHow, type LoginStatus, type PlanUsage } from "@xdev-hive/core";
import { expandEnv, expandHome, resolveBin } from "./command.ts";
import { parseClaudeResult, parsePlanUsage, readCodexUsage } from "./usage.ts";

/** Status and sign-in subcommands of the CLIs that have them. Gemini and custom CLIs have none. */
const COMMANDS: Partial<Record<AgentKind, { status: string[]; login: string[] }>> = {
  claude: { status: ["auth", "status", "--json"], login: ["auth", "login"] },
  codex: { status: ["login", "status"], login: ["login"] },
};

/** Env that picks a login dir: shown in the sign-in command. Other env (keys, tokens) never is. */
const LOGIN_DIRS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

const UNKNOWN = { loggedIn: null, method: null } as const;

/** Reads a status command's answer. Anything unexpected is "unknown", never a guess. */
export function parseLogin(kind: AgentKind, code: number | null, output: string): Pick<LoginStatus, "loggedIn" | "method" | "account"> {
  if (kind === "claude") {
    try {
      const json = JSON.parse(output.slice(output.indexOf("{"))) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown };
      if (typeof json.loggedIn !== "boolean") return UNKNOWN;
      const method = [json.authMethod, json.subscriptionType].filter((v) => typeof v === "string" && v && v !== "none").join(" · ");
      const account = json.loggedIn && typeof json.email === "string" && json.email ? { account: json.email } : {};
      return { loggedIn: json.loggedIn, method: json.loggedIn && method ? method : null, ...account };
    } catch {
      return UNKNOWN;
    }
  }
  if (kind === "codex") {
    if (/not logged in|logged out/i.test(output)) return { loggedIn: false, method: null };
    const signedIn = /logged in(?: using ([^\n]+))?/i.exec(output);
    return signedIn && code === 0 ? { loggedIn: true, method: signedIn[1]?.trim() || null } : UNKNOWN;
  }
  return UNKNOWN;
}

/** An email for the sign-in page: no spaces or quotes, so it is one argument wherever the terminal is. */
const EMAIL = /^[^\s@"'`$\\%^&|<>]{1,100}@[^\s@"'`$\\%^&|<>]{1,100}$/;

/** A way of signing in as the renderer sent it: only true turns an option on, and only a string is an email. */
export function readLoginHow(raw: unknown): LoginHow {
  const h = (raw ?? {}) as Record<string, unknown>;
  return { sso: h.sso === true, console: h.console === true, device: h.device === true, ...(typeof h.email === "string" ? { email: h.email } : {}) };
}

/** The CLI's own options for a way of signing in (roadmap 24b); options of the other CLI are ignored. */
export function loginFlags(kind: AgentKind, how: LoginHow = {}): string[] {
  if (kind === "claude") {
    const email = how.email?.trim();
    if (email && !EMAIL.test(email)) throw new HiveError("bad_request", `Not an email: ${email}`, { key: "errors.badEmail", vars: { email } });
    return [...(how.console ? ["--console"] : []), ...(how.sso ? ["--sso"] : []), ...(email ? ["--email", email] : [])];
  }
  if (kind === "codex") return how.device ? ["--device-auth"] : [];
  return [];
}

/** The login-dir env of a profile, expanded: what a terminal script may hold (keys and tokens never go in a file). */
export function loginDirEnv(profile: AgentProfile): Record<string, string> {
  return expandEnv(Object.fromEntries(Object.entries(profile.env).filter(([k]) => LOGIN_DIRS.includes(k))));
}

/** Sign-in args and the login-dir env (expanded) of a profile, for a terminal to run; null when the CLI has none. */
export function loginParts(profile: AgentProfile, how: LoginHow = {}): { args: string[]; env: Record<string, string> } | null {
  const commands = COMMANDS[profile.kind];
  if (!commands) return null;
  return { args: [...commands.login, ...loginFlags(profile.kind, how)], env: loginDirEnv(profile) };
}

/** The env var that points a CLI at a sign-in folder, for the kinds that have one. */
export const LOGIN_DIR_ENV: Partial<Record<AgentKind, string>> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };

export function loginCommand(profile: AgentProfile): string | null {
  const commands = COMMANDS[profile.kind];
  if (!commands) return null;
  const dirs = Object.entries(profile.env)
    .filter(([k]) => LOGIN_DIRS.includes(k))
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  return `${dirs}${profile.bin} ${commands.login.join(" ")}`;
}

export type RunCli = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;

/** Out of any repo: the checks must not pick up a project's settings. */
const runCli: RunCli = (bin, args, env) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, cwd: os.tmpdir(), timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

export async function checkLogin(profile: AgentProfile, baseEnv: NodeJS.ProcessEnv, now: Date, run: RunCli = runCli): Promise<LoginStatus> {
  const commands = COMMANDS[profile.kind];
  const base = { loginCommand: loginCommand(profile), checkedAt: now.toISOString() };
  const bin = commands ? resolveBin(expandHome(profile.bin), baseEnv.PATH ?? "") : null;
  if (!commands || !bin) return { ...UNKNOWN, ...base };
  const res = await run(bin, commands.status, { ...baseEnv, ...expandEnv(profile.env) });
  return { ...parseLogin(profile.kind, res.code, res.output), ...base };
}

/**
 * Claude Code's /usage slash command answers locally (no model turn, no quota): the plan's session and
 * weekly shares. No hooks, no MCP servers, user settings only, so a check starts nothing else.
 */
export const USAGE_ARGS = [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
  "--setting-sources",
  "user",
  "--strict-mcp-config",
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
];

/** The folder a Codex profile keeps its sign-in and sessions in: its CODEX_HOME, else ~/.codex. */
export function codexHome(profile: AgentProfile): string {
  return profile.env.CODEX_HOME ? expandHome(profile.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

/** Plan usage: Claude Code's /usage, Codex's session files (no CLI started, roadmap 45); null for the other CLIs. */
export async function checkUsage(profile: AgentProfile, baseEnv: NodeJS.ProcessEnv, now: Date, run: RunCli = runCli): Promise<PlanUsage | null> {
  if (profile.kind === "codex") return readCodexUsage(codexHome(profile), now);
  if (profile.kind !== "claude") return null;
  const bin = resolveBin(expandHome(profile.bin), baseEnv.PATH ?? "");
  if (!bin) return null;
  const res = await run(bin, USAGE_ARGS, { ...baseEnv, ...expandEnv(profile.env) });
  const text = parseClaudeResult(res.output)?.text;
  return text ? parsePlanUsage(text, now) : null;
}

/** The last sign-in check of every enabled profile. The runner skips profiles known to be signed out. */
export class LoginMonitor {
  readonly #checks = new Map<string, LoginStatus>();
  readonly #usage = new Map<string, PlanUsage>();
  readonly #profiles: () => AgentProfile[];
  readonly #env: () => NodeJS.ProcessEnv;
  readonly #run: RunCli;
  // Codex's numbers turn to 0 once their reset is past, so a test pins the clock instead of depending on when it runs.
  readonly #now: () => Date;

  constructor(profiles: () => AgentProfile[], env: () => NodeJS.ProcessEnv, run: RunCli = runCli, now: () => Date = () => new Date()) {
    this.#profiles = profiles;
    this.#env = env;
    this.#run = run;
    this.#now = now;
  }

  get(profileId: string): LoginStatus | undefined {
    return this.#checks.get(profileId);
  }

  /** Plan usage of a signed-in Claude Code or Codex profile, from the same check. */
  usage(profileId: string): PlanUsage | undefined {
    return this.#usage.get(profileId);
  }

  /**
   * A profile just made for an account that is not signed in yet (roadmap 24b): signed out until a check says
   * otherwise, so no run goes to it while that check is still on its way (an unknown status counts as signed in).
   */
  expectSignedOut(profile: AgentProfile): void {
    this.#checks.set(profile.id, { loggedIn: false, method: null, loginCommand: loginCommand(profile), checkedAt: this.#now().toISOString() });
  }

  /**
   * Codex writes its limits into the session file at every turn: read again as soon as a run on the profile ends,
   * so the next pick and the stop threshold see that run's share instead of the one from the last 10-minute check.
   */
  rereadUsage(profileId: string): void {
    const p = this.#profiles().find((x) => x.id === profileId && x.enabled);
    if (p?.kind !== "codex" || this.#checks.get(p.id)?.loggedIn === false) return;
    const usage = readCodexUsage(codexHome(p), this.#now());
    if (usage) this.#usage.set(p.id, usage);
  }

  /** Profiles last seen signed out: the ones worth checking again when the user comes back to the app. */
  signedOut(): string[] {
    return [...this.#checks].filter(([, s]) => s.loggedIn === false).map(([id]) => id);
  }

  /** Checks the given profiles (default: every enabled one), one at a time. */
  async refresh(ids?: string[]): Promise<void> {
    const profiles = this.#profiles();
    for (const p of profiles.filter((x) => x.enabled && (!ids || ids.includes(x.id)))) {
      const login = await checkLogin(p, this.#env(), this.#now(), this.#run);
      this.#checks.set(p.id, login);
      // Codex's numbers come from files, not from its sign-in: only a profile known to be signed out goes without.
      const usage = login.loggedIn || (p.kind === "codex" && login.loggedIn !== false) ? await checkUsage(p, this.#env(), this.#now(), this.#run) : null;
      if (usage) this.#usage.set(p.id, usage);
      else this.#usage.delete(p.id);
    }
    // The profiles as they are now: one added while this check ran keeps what is known of it.
    const now = this.#profiles();
    for (const id of [...this.#checks.keys()]) {
      if (now.some((p) => p.id === id && p.enabled)) continue;
      this.#checks.delete(id);
      this.#usage.delete(id);
    }
  }
}
