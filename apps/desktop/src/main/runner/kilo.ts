import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { autonomyOf, type AgentProfile, type Autonomy } from "@xdev-hive/core";
import type { RunUsage } from "#desktop/main/runner/usage.ts";

export const KILO_FREE_MODEL = "kilo/kilo-auto/free";
export const KILO_XDG_DIRS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
const defaults = [".config", ".local/share", ".cache", ".local/state"];
const expand = (p: string) => p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

/** Config alone does not isolate credentials; every account gets all four XDG roots. */
export function kiloAccountEnv(root: string): Record<string, string> {
  return Object.fromEntries(KILO_XDG_DIRS.map((key, i) => [key, path.join(root, ["config", "data", "cache", "state"][i]!)]));
}

export function kiloPaths(env: NodeJS.ProcessEnv, home = os.homedir()): string[] {
  return KILO_XDG_DIRS.map((key, i) => path.join(env[key] ? expand(env[key]!) : path.join(home, defaults[i]!), "kilo"));
}

/** Credential presence is local evidence, not proof that a token is valid or has free entitlement. */
export function kiloLogin(env: NodeJS.ProcessEnv): { loggedIn: boolean | null; method: string | null } {
  try {
    const raw = env.KILO_AUTH_CONTENT || readFileSync(path.join(kiloPaths(env)[1]!, "auth.json"), "utf8");
    const auth = JSON.parse(raw);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return { loggedIn: null, method: null };
    const credential = auth.kilo;
    if (!credential) return { loggedIn: null, method: null };
    const present = credential.type === "api" ? typeof credential.key === "string" && !!credential.key
      : credential.type === "oauth" ? typeof credential.access === "string" && !!credential.access : false;
    return { loggedIn: present ? true : null, method: present ? "Kilo · credential stored" : null };
  } catch { return { loggedIn: null, method: null }; }
}

export function kiloPermission(level: Autonomy, servers: string[]): Record<string, string> {
  const readonly = level === "read" || level === "propose";
  return {
    "*": level === "full" ? "allow" : readonly ? "deny" : "ask",
    read: "allow", glob: "allow", grep: "allow", list: "allow",
    edit: readonly ? "deny" : "allow", bash: readonly ? "deny" : level === "full" ? "allow" : "ask",
    // Native tool permissions are not an OS sandbox; a container is the host boundary.
    external_directory: "deny",
    ...Object.fromEntries(servers.map((name) => [`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`, "allow"])),
  };
}

/** The runner owns this config. User credentials stay in the profile's data root. */
export function kiloRunEnv(profile: AgentProfile, servers: Record<string, Record<string, unknown>>, configRoot: string): Record<string, string> {
  const level = autonomyOf(profile.kind, profile.args);
  const mcp = Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, s.type === "http" ? {
    type: "remote", url: s.url, headers: s.headers, oauth: false, enabled: true,
  } : {
    type: "local", command: [s.command, ...(Array.isArray(s.args) ? s.args : [])],
    environment: s.env ?? {}, enabled: true,
  }]));
  return {
    XDG_CONFIG_HOME: configRoot,
    // Project-config suppression still scans ~/.kilo and ~/.kilocode via Global.Path.home.
    KILO_TEST_HOME: configRoot, KILO_DISABLE_CLAUDE_CODE: "1", KILO_DISABLE_EXTERNAL_SKILLS: "1",
    KILO_CONFIG: "", KILO_CONFIG_DIR: "",
    KILO_DISABLE_PROJECT_CONFIG: "1", KILO_DISABLE_AUTOUPDATE: "1", KILO_PURE: "1",
    KILO_CONFIG_CONTENT: JSON.stringify({ model: KILO_FREE_MODEL, small_model: KILO_FREE_MODEL, mcp, share: "disabled", autoupdate: false }),
    KILO_PERMISSION: JSON.stringify(kiloPermission(level, Object.keys(servers))),
  };
}

const count = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
type Json = Record<string, any>;

/** Kilo 7.8 run JSONL: completed parts, not OpenCode's parser or account remaining quota. */
export class KiloStream {
  readonly state = { activity: null as string | null };
  readonly skills = new Set<string>();
  lastText: string | null = null;
  sessionId: string | null = null;
  error: string | null = null;
  #rest = "";
  #parts = new Set<string>();
  #usage: RunUsage = { text: null, costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
  get usage(): RunUsage { return { ...this.#usage, text: this.lastText }; }
  push(chunk: string): string {
    const lines = (this.#rest + chunk).split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((l) => this.#line(l)).join("");
  }
  end(): string { const rest = this.#rest; this.#rest = ""; return rest ? this.#line(rest) : ""; }
  #line(raw: string): string {
    if (!raw.trim()) return "";
    let e: Json;
    try { e = JSON.parse(raw); } catch { return raw + "\n"; }
    if (!e || typeof e !== "object") return raw + "\n";
    if (typeof e.sessionID === "string") this.sessionId = e.sessionID;
    const p = e.part;
    if (e.type === "error") {
      this.error = typeof e.error === "string" ? e.error : e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? "Kilo error";
      return `✗ ${this.error}\n`;
    }
    if (!p || typeof p !== "object") return raw + "\n";
    if (typeof p.id === "string") {
      const key = `${e.type}:${p.id}`;
      if (this.#parts.has(key)) return "";
      this.#parts.add(key);
    }
    if (e.type === "text" && typeof p.text === "string") {
      this.lastText = p.text.trim() || this.lastText;
      this.state.activity = p.text.replace(/\s+/g, " ").slice(0, 160);
      return p.text + "\n";
    }
    if (e.type === "tool_use") {
      this.state.activity = String(p.state?.title ?? p.tool ?? "tool").slice(0, 160);
      const input = p.state?.input;
      const skill = /(?:^|_)skill_get$/.test(String(p.tool)) ? input?.name
        : p.tool === "read" && typeof input?.filePath === "string" ? /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/.exec(input.filePath)?.[1] : null;
      if (p.state?.status === "completed" && typeof skill === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(skill) && this.skills.size < 256) this.skills.add(skill);
      return `${p.state?.status === "error" ? "✗" : "▶"} ${this.state.activity}${p.state?.error ? `: ${p.state.error}` : ""}\n`;
    }
    if (e.type === "step_finish") {
      const values: Partial<RunUsage> = {
        costUsd: count(p.cost), inputTokens: count(p.tokens?.input), outputTokens: count(p.tokens?.output),
        cacheReadTokens: count(p.tokens?.cache?.read), cacheWriteTokens: count(p.tokens?.cache?.write),
      };
      for (const key of ["costUsd", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        const n = values[key]; if (n != null) this.#usage[key] = (this.#usage[key] ?? 0) + n;
      }
      return `# step ${String(p.reason ?? "finished")} · tokens out ${values.outputTokens ?? "?"}\n`;
    }
    if (e.type === "step_start") return `# session ${this.sessionId ?? "?"} · Kilo\n`;
    if (e.type === "reasoning") return "";
    return raw + "\n";
  }
}
