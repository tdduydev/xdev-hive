import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { cleanupSuggestionSchema, effectivePolicy, modelsFor, MEMORY_CLEANUP_BRIEF, type MemoryCleanupError, type AgentProfile, type MemoryCleanupRun } from "@xdev-hive/core";
import { memoryCleanupMcp } from "@xdev-hive/mcp";
import type { AssistHost } from "#desktop/main/runner/assist.ts";
import { expandEnv, resolveBin } from "#desktop/main/runner/command.ts";
import { killTree } from "#desktop/main/runner/kill.ts";
import { parseResult } from "#desktop/main/runner/chat.ts";
import { ClaudeStream } from "#desktop/main/runner/stream.ts";

export function parseCleanupSuggestions(text: string) {
  const raw = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return z.array(cleanupSuggestionSchema).max(30).parse(JSON.parse(raw));
}

/** A separate read-only run, outside any repo: results go to the hub's human review queue. */
export class MemoryCleanupWorker {
  readonly #host: AssistHost;
  readonly #dataDir: string;
  #inflight: Promise<void> | null = null;
  #stop: (() => void) | null = null;
  #polling = false;
  #taking: Promise<MemoryCleanupRun | null> | null = null;
  #stopping = false;
  #off = false;
  #profileId: string | null = null;
  get profileId(): string | null { return this.#profileId; }
  constructor(host: AssistHost, dataDir: string) { this.#host = host; this.#dataDir = dataDir; }
  #pick(): AgentProfile | null {
    return this.#host.profiles().filter((p) => p.enabled && p.kind === "claude" && !p.container && !this.#host.unavailable?.(p.id)).sort((a,b) => a.priority-b.priority)[0] ?? null;
  }
  async poll(): Promise<boolean> {
    if (this.#off || this.#stopping || this.#inflight || this.#polling) return false;
    const profile = this.#pick();
    if (!profile) return false;
    this.#polling = true;
    this.#profileId = profile.id;
    try {
      this.#taking = this.#host.backend().call("memory.cleanupTake", { projects: this.#host.projects().map((p) => p.name) }, this.#host.actor());
      const job = await this.#taking;
      if (!job) return false;
      this.#inflight = this.#write(job, profile).finally(() => { this.#inflight = null; this.#stop = null; this.#profileId = null; });
      return true;
    } catch (err) {
      if (err instanceof Error && /unknown method/i.test(err.message)) this.#off = true;
      throw err;
    } finally {
      this.#taking = null; this.#polling = false;
      if (!this.#inflight) this.#profileId = null;
    }
  }
  stop(): void { this.#stopping = true; this.#stop?.(); }
  async settle(): Promise<void> { await this.#taking?.catch(() => null); await this.#inflight; }
  async #write(job: MemoryCleanupRun, profile: AgentProfile): Promise<void> {
    const backend = this.#host.backend();
    const actor = this.#host.actor();
    const cwd = path.join(this.#dataDir, "runs", `memory-cleanup-${job.id}`);
    let bridge: Awaited<ReturnType<typeof memoryCleanupMcp>> | null = null;
    let tick: NodeJS.Timeout | undefined;
    let limit: NodeJS.Timeout | undefined;
    let error: MemoryCleanupError | undefined;
    let costUsd: number | null = null;
    let model = "haiku";
    let suggestions: ReturnType<typeof parseCleanupSuggestions> = [];
    try {
      mkdirSync(cwd, { recursive: true });
      if (this.#stopping) { error = "stopped"; throw new Error(); }
      const view = await backend.call("agentPolicy.get", {}, actor);
      const policy = effectivePolicy(view.hub, view.projects[job.project] ?? null);
      const allowed = modelsFor(policy, "claude");
      model = allowed?.find((m) => m === "haiku" || m.startsWith("claude-haiku-")) ?? (allowed ? "" : "haiku");
      if (!model) { error = "model"; throw new Error(); }
      const base = this.#host.env();
      const bin = resolveBin(profile.bin, base.PATH ?? "");
      if (!bin) { error = "cli"; throw new Error(); }
      bridge = await memoryCleanupMcp(backend, actor, job.id);
      if (this.#stopping) { error = "stopped"; throw new Error(); }
      // The bridge keeps the machine's credentials in this process; the AI receives only an ephemeral read token.
      const env = Object.fromEntries(Object.entries({ ...base, ...expandEnv(profile.env) }).filter(([k]) => !k.startsWith("HIVE_") && !k.startsWith("ELECTRON_")));
      const args = ["-p", "--disable-slash-commands", "--model", model, "--output-format", "stream-json", "--verbose", "--tools", "", "--allowedTools", "mcp__memory_review__memory_list",
        "--settings", JSON.stringify({ disableAllHooks: true }), "--setting-sources", "", "--strict-mcp-config", "--mcp-config",
        JSON.stringify({ mcpServers: { memory_review: { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } } }),
        "--no-session-persistence", "--append-system-prompt", MEMORY_CLEANUP_BRIEF];
      const stream = new ClaudeStream(cwd);
      const decoder = new StringDecoder("utf8");
      const child = spawn(bin, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.#stop = () => { error = "stopped"; killTree(child); };
      child.stdin.on("error", () => undefined);
      child.stdin.end(`Review memory for project ${job.project}. Read all pages through memory_list; return the JSON array of proposals.`);
      child.stdout.on("data", (chunk: Buffer) => stream.push(decoder.write(chunk)));
      // CLI output may contain credentials or memory: retain only a generic failure, never raw stderr.
      child.stderr.on("data", () => undefined);
      tick = setInterval(() => {
        void backend.call("memory.cleanupProgress", { id: job.id }, actor).then((r) => { if (!r.ok) this.#stop?.(); }).catch(() => undefined);
      }, 30_000);
      limit = setTimeout(() => { error = "timeout"; killTree(child); }, 10 * 60_000);
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      stream.push(decoder.end()); stream.end();
      const result = parseResult(stream.result);
      costUsd = result?.costUsd ?? null;
      if (error || code !== 0 || !result || result.isError) throw new Error(error ?? `Memory cleanup CLI exited with code ${code}`);
      suggestions = parseCleanupSuggestions(result.text ?? "");
    } catch (err) {
      // Parse errors may echo model output; only fixed messages are persisted.
      error = err instanceof SyntaxError || err instanceof z.ZodError ? "result" : error ?? "failed";
    } finally {
      clearInterval(tick); clearTimeout(limit);
      await bridge?.close().catch(() => undefined);
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* The next run uses a different scratch folder. */ }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await backend.call("memory.cleanupFinish", { id: job.id, suggestions, profile: profile.id, model: model || "haiku", costUsd, ...(error ? { error } : {}) }, actor); return; }
      catch {
        suggestions = []; error = "hub";
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
