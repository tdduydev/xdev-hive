import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile, Autonomy } from "@xdev-hive/core";

export const OPENCODE_XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
const expand = (v: string, home: string) => v === "~" ? home : v.startsWith("~/") ? path.join(home, v.slice(2)) : v;

/** Config alone does not isolate auth.json, sessions or startup logs. */
export function opencodeEnv(profile: AgentProfile, home = os.homedir()): Record<string, string> {
  const root = path.join(home, ".xdev-hive", "accounts", profile.id);
  return Object.fromEntries(OPENCODE_XDG.map((k, i) => [k, expand(profile.env[k] || path.join(root, ["config", "data", "cache", "state"][i]!), home)]));
}

/** JSONC is accepted by OpenCode. Strip comments outside strings, then trailing commas outside strings. */
export function opencodeJson(text: string): Record<string, any> {
  let out = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); if (end < 0) throw new Error("Unclosed OpenCode config comment"); i = end + 1; out += " "; continue; }
    out += c;
  }
  quoted = false; escaped = false;
  let clean = "";
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (!quoted && c === "," && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    clean += c;
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
  }
  const value = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenCode config must be an object");
  return value;
}

/** Read only the person's configuration; repo plugins and agents must not widen a run's policy. */
export function opencodeUserConfig(profile: AgentProfile): Record<string, any> {
  const env = opencodeEnv(profile);
  const dirs = [path.join(env.XDG_CONFIG_HOME!, "opencode"), ...(profile.env.OPENCODE_CONFIG_DIR ? [expand(profile.env.OPENCODE_CONFIG_DIR, os.homedir())] : [])];
  const files = [...dirs.flatMap((dir) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]), ...(profile.env.OPENCODE_CONFIG ? [expand(profile.env.OPENCODE_CONFIG, os.homedir())] : [])];
  let config: Record<string, any> = {};
  const merge = (next: Record<string, any>) => { config = { ...config, ...next, provider: { ...config.provider, ...next.provider }, mcp: { ...config.mcp, ...next.mcp } }; };
  for (const file of new Set(files)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
    merge(opencodeJson(text));
  }
  if (profile.env.OPENCODE_CONFIG_CONTENT) merge(opencodeJson(profile.env.OPENCODE_CONFIG_CONTENT));
  return config;
}

/** Headless cannot ask for shell approval. Edit matches acceptEdits: edits allowed, arbitrary shell denied. */
export function opencodePermissions(level: Autonomy, servers: string[]): Record<string, unknown> {
  return {
    "*": "deny",
    read: "allow", glob: "allow", grep: "allow", list: "allow", webfetch: "allow", websearch: "allow", skill: "allow", todowrite: "allow", lsp: "allow",
    edit: level === "read" || level === "propose" ? "deny" : "allow",
    bash: level === "full" ? "allow" : "deny",
    external_directory: "deny", task: "deny", question: "deny", plan_enter: "deny", plan_exit: "deny",
    ...Object.fromEntries(servers.map((name) => [`${name}_*`, "allow"])),
  };
}

/** Credential presence is not proof that a key/OAuth token is valid. Never expose credential contents. */
export function opencodeLogin(profile: AgentProfile): { loggedIn: boolean | null; method: string | null } {
  const provider = (profile.opencode?.model ?? "").split("/")[0];
  if (!provider) return { loggedIn: null, method: null };
  try {
    const auth = JSON.parse(readFileSync(path.join(opencodeEnv(profile).XDG_DATA_HOME!, "opencode", "auth.json"), "utf8"));
    const entry = auth?.[provider];
    return entry && (entry.type === "api" || entry.type === "oauth") ? { loggedIn: null, method: `${provider} · ${entry.type}` } : { loggedIn: null, method: null };
  } catch { return { loggedIn: null, method: null }; }
}
