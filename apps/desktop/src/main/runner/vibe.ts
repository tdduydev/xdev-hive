import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { flagValue } from "@xdev-hive/core";
import type { RunUsage } from "#desktop/main/runner/usage.ts";
import { toolLine, type StreamState } from "#desktop/main/runner/stream.ts";

/** Contract checked against the research probe and installed mistral-vibe 2.26.0 source. */
export const VIBE_VERSION = "2.26.0";
// Native MCP tools default to ASK, which programmatic mode denies. Approve Hive's exposed API only;
// the shim still enforces the actor role and HIVE_READONLY, including writes at an edit-level run.
export const VIBE_HIVE_TOOLS = [
  "doc_list", "doc_get", "doc_asset", "artifact_list", "artifact_get", "doc_propose",
  "skill_list", "skill_get", "skill_propose", "memory_search", "memory_write", "memory_list",
  "task_list", "task_get", "task_notes", "task_next", "task_claim", "task_update",
  "run_list", "run_get", "machine_list", "project_list", "cost_summary", "run_requests",
  "policy_get", "setup_missing", "tool_list", "tool_status", "token_usage", "alert_list",
  "propose_task", "propose_task_status", "propose_task_classify", "propose_run", "propose_task_agent",
  "propose_cancel_run", "propose_merge", "propose_profile", "propose_policy", "propose_stop_agents",
  "propose_resume_agents", "propose_install", "propose_tool",
];
export const VIBE_DEFAULT_MODELS = ["mistral-medium-3.5", "local"];
type Json = Record<string, any>;
const object = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const textOf = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v)
  ? v.filter((b) => object(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n") : "";

/** Vibe emits completed history entries, not token deltas or Claude result events. */
export class VibeStream {
  readonly state: StreamState = { activity: null };
  lastText: string | null = null;
  sessionId: string | null = null;
  failure: string | null = null;
  #rest = "";
  #seen = new Set<string>();
  readonly cwd: string;
  readonly format: "streaming" | "json";
  constructor(cwd: string, format: "streaming" | "json" = "streaming") {
    this.cwd = cwd;
    this.format = format;
  }
  push(chunk: string): string {
    this.#rest += chunk;
    if (this.format === "json") return "";
    const lines = this.#rest.split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((l) => this.#line(l)).join("");
  }
  end(): string {
    const tail = this.#rest;
    this.#rest = "";
    if (this.format === "streaming") return this.#line(tail);
    try {
      const data = JSON.parse(tail);
      const entries = Array.isArray(data) ? data : data.history;
      return Array.isArray(entries) ? entries.map((e) => this.#entry(e)).join("") : `${tail}\n`;
    } catch { return tail ? `${tail}\n` : ""; }
  }
  #line(line: string): string {
    if (!line.trim()) return "";
    try { return this.#entry(JSON.parse(line)); }
    catch { return `${line}\n`; }
  }
  #entry(e: unknown): string {
    if (!object(e)) return "";
    const status = e.generationStatus ?? e.generation_status;
    if (status && status !== "completed") return "";
    if (typeof e.id === "string") {
      if (this.#seen.has(e.id)) return "";
      this.#seen.add(e.id);
    }
    const session = e.sessionId ?? e.session_id;
    let prefix = "";
    if (typeof session === "string" && /^[\w-]{1,100}$/.test(session) && this.sessionId !== session) {
      this.sessionId = session;
      prefix = `# session ${session}\n`;
    }
    if (e.role === "assistant") {
      const text = textOf(e.content);
      if (text.trim()) this.lastText = text.trim();
      const calls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
      const tools = calls.filter(object).map((t) => {
        let input = {};
        try { input = JSON.parse(t.function?.arguments ?? "{}"); } catch { /* Partial legacy arguments. */ }
        this.state.activity = toolLine(t.function?.name ?? "?", input, this.cwd);
        return `▶ ${this.state.activity}\n`;
      }).join("");
      return prefix + (text.trim() ? `${text.trim()}\n` : "") + tools;
    }
    if (e.role === "tool") return prefix + `  ${textOf(e.content)}\n`;
    if (e.type === "effect" && object(e.detail) && object(e.state)) {
      const name = e.detail.toolName ?? e.detail.tool_name ?? e.title ?? "?";
      this.state.activity = toolLine(name, object(e.detail.input) ? e.detail.input : {}, this.cwd);
      const result = e.state.outputText ?? e.state.output_text ?? e.state.error?.message ?? "";
      return prefix + `▶ ${this.state.activity}\n  ${e.state.status === "failed" ? "✗" : "✓"} ${result}\n`;
    }
    if (e.type === "notice" && typeof e.message === "string") {
      if (e.level === "error") this.failure = e.message;
      return prefix + `${e.level === "error" ? "✗" : "#"} ${e.message}\n`;
    }
    return prefix;
  }
}

/** Only the current run's dedicated save_dir; never a global "latest session" or another account's usage. */
export function readVibeSession(dir: string, cwd: string, sessionId: string | null, text: string | null): { sessionId: string; usage: RunUsage | null } | null {
  try {
    // macOS resolves /var to /private/var in the CLI's cwd; both name the same worktree.
    const canonical = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
    const worktree = canonical(cwd);
    const rows = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 100);
    const matches: Array<{ sessionId: string; usage: RunUsage | null }> = [];
    for (const row of rows) {
      const file = path.join(dir, row.name, "meta.json");
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
        const m = JSON.parse(readFileSync(file, "utf8"));
        if (m.parent_session_id || typeof m.environment?.working_directory !== "string" || canonical(m.environment.working_directory) !== worktree || typeof m.session_id !== "string" ||
          !/^[\w-]{1,100}$/.test(m.session_id) || (sessionId && m.session_id !== sessionId)) continue;
        const s = m.stats;
        const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
        const known = s && number(s.session_prompt_tokens) && number(s.session_completion_tokens) && number(s.session_cached_tokens) && s.session_cached_tokens <= s.session_prompt_tokens;
        matches.push({ sessionId: m.session_id, usage: known ? {
          text, costUsd: null, inputTokens: s.session_prompt_tokens - s.session_cached_tokens,
          cacheReadTokens: s.session_cached_tokens, cacheWriteTokens: null, outputTokens: s.session_completion_tokens,
        } : null });
      } catch { /* Missing, disabled or incomplete session logging means unknown usage. */ }
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}

/** Read simple [[models]] aliases from the profile config; complex/unknown TOML stays unknown. */
export function vibeModels(config: string): string[] | null {
  const tables = config.split(/^\s*\[\[models\]\]\s*(?:#.*)?$/m).slice(1);
  const aliases = tables.map((t) => {
    const body = t.split(/^\s*\[/m)[0]!;
    const value = /^\s*(?:alias|name)\s*=\s*["']([A-Za-z0-9._:[\]-]{1,100})["']\s*(?:#.*)?$/m;
    const alias = /^\s*alias\s*=\s*["']([A-Za-z0-9._:[\]-]{1,100})["']\s*(?:#.*)?$/m.exec(body)?.[1];
    return /^\s*alias\s*=/m.test(body) ? alias : value.exec(body)?.[1];
  });
  return aliases.length && aliases.every(Boolean) ? [...new Set(aliases as string[])] : null;
}

/** Vibe permits a local TOML to shadow builtin agent names, after CLI/env overrides. */
export function vibeAgentUnverified(cwd: string, env: NodeJS.ProcessEnv, args: string[]): boolean {
  const agent = flagValue(args, ["--agent"]);
  if (!agent || !["ask", "plan", "accept-edits"].includes(agent)) return false;
  const home = env.VIBE_HOME || path.join(env.HOME || os.homedir(), ".vibe");
  const roots = [cwd];
  args.forEach((a, i) => {
    if (a === "--add-dir" && args[i + 1]) roots.push(path.resolve(cwd, args[i + 1]!));
    else if (a.startsWith("--add-dir=")) roots.push(path.resolve(cwd, a.slice(10)));
  });
  const folders = [home, ...roots.map((r) => path.join(r, ".vibe"))];
  if (env.VIBE_AGENT_PATHS && env.VIBE_AGENT_PATHS.trim() !== "[]") return true;
  return folders.some((folder) => {
    if (existsSync(path.join(folder, "agents", `${agent}.toml`))) return true;
    try {
      // Additional search paths may contain a shadowing agent. Complex TOML is left to native Vibe, fail closed here.
      const config = readFileSync(path.join(folder, "config.toml"), "utf8");
      return /^\s*agent_paths\s*=/m.test(config) && !/^\s*agent_paths\s*=\s*\[\s*\]\s*(?:#.*)?$/m.test(config);
    } catch { return false; }
  });
}
