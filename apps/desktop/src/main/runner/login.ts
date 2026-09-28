// Whether each profile's CLI is signed in, asked from the CLI itself with the profile's env, so a
// second login dir (CLAUDE_CONFIG_DIR, CODEX_HOME) is checked on its own. No Electron imports.
import { execFile } from "node:child_process";
import type { AgentKind, AgentProfile, LoginStatus } from "@xdev-hive/core";
import { expandEnv, expandHome, resolveBin } from "./command.ts";

/** Status and sign-in subcommands of the CLIs that have them. Gemini and custom CLIs have none. */
const COMMANDS: Partial<Record<AgentKind, { status: string[]; login: string[] }>> = {
  claude: { status: ["auth", "status", "--json"], login: ["auth", "login"] },
  codex: { status: ["login", "status"], login: ["login"] },
};

/** Env that picks a login dir: shown in the sign-in command. Other env (keys, tokens) never is. */
const LOGIN_DIRS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

const UNKNOWN = { loggedIn: null, method: null } as const;

/** Reads a status command's answer. Anything unexpected is "unknown", never a guess. */
export function parseLogin(kind: AgentKind, code: number | null, output: string): Pick<LoginStatus, "loggedIn" | "method"> {
  if (kind === "claude") {
    try {
      const json = JSON.parse(output.slice(output.indexOf("{"))) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
      if (typeof json.loggedIn !== "boolean") return UNKNOWN;
      const method = [json.authMethod, json.subscriptionType].filter((v) => typeof v === "string" && v && v !== "none").join(" · ");
      return { loggedIn: json.loggedIn, method: json.loggedIn && method ? method : null };
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

const runCli: RunCli = (bin, args, env) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
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

/** The last sign-in check of every enabled profile. The runner skips profiles known to be signed out. */
export class LoginMonitor {
  readonly #checks = new Map<string, LoginStatus>();
  readonly #profiles: () => AgentProfile[];
  readonly #env: () => NodeJS.ProcessEnv;
  readonly #run: RunCli;

  constructor(profiles: () => AgentProfile[], env: () => NodeJS.ProcessEnv, run: RunCli = runCli) {
    this.#profiles = profiles;
    this.#env = env;
    this.#run = run;
  }

  get(profileId: string): LoginStatus | undefined {
    return this.#checks.get(profileId);
  }

  /** Checks the given profiles (default: every enabled one), one at a time. */
  async refresh(ids?: string[]): Promise<void> {
    const profiles = this.#profiles();
    for (const p of profiles.filter((x) => x.enabled && (!ids || ids.includes(x.id)))) {
      this.#checks.set(p.id, await checkLogin(p, this.#env(), new Date(), this.#run));
    }
    for (const id of [...this.#checks.keys()]) if (!profiles.some((p) => p.id === id && p.enabled)) this.#checks.delete(id);
  }
}
