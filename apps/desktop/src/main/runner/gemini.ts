import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoginStatus, ToolEntry } from "@xdev-hive/core";
import { MCP_NAME, NO_FEATURES, runMcpServers } from "#desktop/main/installer.ts";
import { claudeToolServer } from "#desktop/main/runner/tools.ts";
import type { StreamState } from "#desktop/main/runner/stream.ts";
import type { RunUsage } from "#desktop/main/runner/usage.ts";

type Json = Record<string, unknown>;
const count = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);

/** 0.63.0 resolves aliases using the account's entitlement; this is not a list of free models. */
export const GEMINI_MODELS = ["auto", "flash", "pro", "flash-lite"];
export function supportsGeminiModels(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
  return !!m && (+m[1]! > 0 || +m[2]! >= 63);
}

export function geminiHome(env: NodeJS.ProcessEnv): string {
  return path.join(env.GEMINI_CLI_HOME || env.HOME || os.homedir(), ".gemini");
}

/** A credential cache cannot prove a refresh succeeds. Never make a model request just to check login. */
export function geminiLogin(env: NodeJS.ProcessEnv): Pick<LoginStatus, "loggedIn" | "method"> {
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") return { loggedIn: null, method: "Vertex AI" };
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { loggedIn: null, method: "API key" };
  const dir = geminiHome(env);
  try {
    const auth = object(object(object(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))).security).auth);
    if (auth.selectedType === "vertex-ai" || auth.selectedType === "gemini-api-key") return { loggedIn: null, method: auth.selectedType };
    const cached = object(JSON.parse(readFileSync(path.join(dir, "oauth_creds.json"), "utf8")));
    if (typeof cached.refresh_token === "string" && cached.refresh_token) return { loggedIn: null, method: "Google OAuth" };
  } catch { /* Missing or unreadable credentials are not evidence of a valid login. */ }
  return { loggedIn: false, method: null };
}

/** Each worktree has its own native MCP settings, so concurrent accounts never rewrite global settings. */
export function prepareGeminiSettings(worktree: string, run: { agent: string; project: string; task: string; id: string; readOnly: boolean }, tools: ToolEntry[], mcp: string[] | null, ctx: { repo?: string; hiveMcp?: string } = {}): void {
  const file = path.join(worktree, ".gemini", "settings.json");
  let settings: Json = {};
  try { settings = object(JSON.parse(readFileSync(file, "utf8"))); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read Gemini settings: ${file}`);
  }
  const servers = Object.fromEntries(Object.entries(object(settings.mcpServers)).filter(([name]) => mcp === null || name === MCP_NAME || mcp.includes(name)));
  Object.assign(servers, runMcpServers(run.agent, run.project, NO_FEATURES, run));
  for (const tool of tools.filter((t) => t.kind === "mcp" && t.mcp && t.id !== MCP_NAME && (mcp === null || mcp.includes(t.id)))) {
    servers[tool.id] = { ...claudeToolServer(tool, { worktree, ...ctx }), trust: true };
  }
  // Headless auto_edit otherwise asks approval for Hive calls and cannot claim or report the task.
  servers[MCP_NAME] = { ...object(servers[MCP_NAME]), trust: true };
  const names = [...new Set(["AGENTS.md", "GEMINI.md", ...[settings.contextFileName ?? [], object(settings.context).fileName ?? []].flat().filter((v): v is string => typeof v === "string")])];
  const general = object(settings.general);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, context: { ...object(settings.context), fileName: names }, contextFileName: names, general: { ...general, plan: { ...object(general.plan), enabled: true } }, mcpServers: servers }, null, 2) + "\n", { mode: 0o600 });
}

/** Native stream stats and the single-JSON telemetry schema have different token field names. */
export function geminiUsage(stats: unknown, text: string | null): RunUsage | null {
  const s = object(stats);
  let input = count(s.input_tokens), cached = count(s.cached), output = count(s.output_tokens);
  if (input === null && s.models) {
    const tokens = Object.values(object(s.models)).map((m) => object(object(m).tokens));
    const sum = (key: string) => tokens.length && tokens.every((t) => count(t[key]) !== null) ? tokens.reduce((n, t) => n + count(t[key])!, 0) : null;
    input = sum("prompt"); cached = sum("cached"); output = sum("candidates");
  }
  if (input === null && output === null) return null;
  return { text, costUsd: null, inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)), cacheReadTokens: cached, cacheWriteTokens: null, outputTokens: output };
}

export function geminiJson(stdout: string): { usage: RunUsage | null; text: string | null; failure: string | null } | null {
  try {
    const j = object(JSON.parse(stdout));
    if (!("response" in j) && !("stats" in j) && !("error" in j)) return null;
    const text = typeof j.response === "string" ? j.response : null;
    return { text, usage: geminiUsage(j.stats, text), failure: j.error ? String(object(j.error).message ?? "Gemini failed") : null };
  } catch { return null; }
}

/** Contract from Gemini CLI v0.63.0 output/stream-json-formatter and nonInteractiveCli. */
export class GeminiStream {
  readonly state: StreamState = { activity: null };
  readonly skills = new Set<string>();
  readonly #skills = new Map<string, string>();
  lastText: string | null = null;
  sessionId: string | null = null;
  failure: string | null = null;
  results = 0;
  usage: RunUsage | null = null;
  #rest = "";
  #openText = false;
  #newMessage = true;
  #seen = false;
  #completed = false;
  push(chunk: string): string {
    const lines = (this.#rest + chunk).split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((l) => this.#line(l)).join("");
  }
  end(): string {
    const rest = this.#rest; this.#rest = "";
    const text = rest ? this.#line(rest) : "";
    if (this.#seen && !this.#completed && !this.failure) this.failure = "Gemini stream ended without a result";
    return text + this.#break();
  }
  #break(): string { const s = this.#openText ? "\n" : ""; this.#openText = false; return s; }
  #line(raw: string): string {
    if (!raw.trim()) return "";
    let e: Json;
    try { e = object(JSON.parse(raw)); } catch { return this.#break() + raw + "\n"; }
    switch (e.type) {
      case "init":
        this.#seen = true; this.#completed = false; this.#newMessage = true;
        if (typeof e.session_id === "string") this.sessionId = e.session_id;
        return this.#break() + `# session ${this.sessionId ?? "?"} · model ${String(e.model ?? "?")} · Gemini CLI\n`;
      case "message": {
        if (e.role !== "assistant" || typeof e.content !== "string") return "";
        if (this.#newMessage || e.delta !== true) this.lastText = "";
        this.#newMessage = false;
        this.lastText = (this.lastText ?? "") + e.content;
        this.state.activity = short(this.lastText);
        this.#openText = !e.content.endsWith("\n");
        return e.content;
      }
      case "tool_use": {
        this.#newMessage = true;
        const p = object(e.parameters), name = String(e.tool_name ?? "?");
        const skill = /(?:^|__)skill_get$/.test(name) ? p.name : name === "read_file" && typeof p.file_path === "string" ? /([^/\\]+)[/\\]SKILL\.md$/.exec(p.file_path)?.[1] : null;
        if (typeof skill === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(skill) && typeof e.tool_id === "string") this.#skills.set(e.tool_id, skill);
        this.state.activity = `${name} ${short(JSON.stringify(p))}`;
        return this.#break() + `▶ ${this.state.activity}\n`;
      }
      case "tool_result": {
        const skill = this.#skills.get(String(e.tool_id));
        if (skill && e.status === "success" && !e.error && this.skills.size < 256) this.skills.add(skill);
        this.#skills.delete(String(e.tool_id));
        return this.#break() + `  ${e.status === "error" ? "✗" : "✓"} ${short(String(object(e.error).message ?? e.output ?? "(no output)"))}\n`;
      }
      case "error":
        if (e.severity === "error") this.failure = String(e.message ?? "Gemini error");
        return this.#break() + `✗ ${short(String(e.message ?? "Gemini warning"))}\n`;
      case "result": {
        this.results++; this.#completed = true;
        if (e.status === "error" || e.error) this.failure = String(object(e.error).message ?? this.failure ?? "Gemini result: error");
        const u = geminiUsage(e.stats, this.lastText);
        if (u) {
          if (this.usage) for (const k of ["inputTokens", "cacheReadTokens", "outputTokens"] as const) u[k] = u[k] === null || this.usage[k] === null ? null : u[k]! + this.usage[k]!;
          this.usage = u;
        }
        return this.#break();
      }
      default: return this.#break() + raw + "\n";
    }
  }
}
