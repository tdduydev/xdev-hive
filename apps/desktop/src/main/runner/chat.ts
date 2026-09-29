// The leader of a project's web chat (roadmap 17): this machine writes the replies the hub hands it, with one of its
// Claude profiles, in the project's repo, resuming the thread's Claude Code session. The leader reaches Hive only
// through the hub's MCP with the reply's own token (the sender's rights, never more than this machine's), may read
// the repo but not change it, and reports as it goes so the web shows the reply while it is written.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { toErrorPayload, type Actor, type AgentProfile, type ChatRequest, type DesktopProject, type HiveBackend, type RunRequestError } from "@xdev-hive/core";
import { expandEnv, resolveBin } from "./command.ts";
import { claudeMcpServers } from "./container-mcp.ts";
import { killTree } from "./kill.ts";
import { detectRateLimit } from "./rate-limit.ts";
import { ClaudeStream } from "./stream.ts";

export interface ChatHost {
  backend(): HiveBackend;
  /** This machine as the hub knows it (the heartbeat's actor): chat.progress and chat.finish go under it. */
  actor(): Actor;
  profiles(): AgentProfile[];
  projects(): DesktopProject[];
  machine(): string;
  env(): NodeJS.ProcessEnv;
  hubUrl(): string | null;
  /** A profile the runner would not start now (signed out, resting, over its plan's limit). */
  unavailable?(profileId: string): boolean;
}

export interface ChatOptions {
  dataDir: string;
  /** How often a reply being written is reported to the hub. */
  progressMs?: number;
  timeoutMinutes?: number;
  /** Replies written at the same time on this machine. */
  maxChats?: number;
}

/** What the hub keeps of a reply: the end of the text and of the steps. */
const TEXT_MAX = 40_000;
const tail = (s: string) => (s.length > TEXT_MAX ? s.slice(-TEXT_MAX) : s);

/** Read the repo, use Hive; never change files or run commands on this machine. */
const LEADER_SETTINGS = {
  disableAllHooks: true,
  permissions: { allow: ["mcp__xdev-hive"], deny: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"] },
};

export const leaderBrief = (project: string, who: string) =>
  [
    `You are the leader agent of project ${project} in xDev Hive, answering ${who} in the Hive web chat.`,
    "Work through the xdev-hive tools (tasks, docs, memory, skills). You may read this repository; you cannot change files or run commands.",
    "Reply in the language of the message, briefly, and say what you did in Hive.",
  ].join(" ");

/** The CLI's arguments; the message itself goes in on stdin, so one starting with "-" is never read as an option. */
export function chatArgs(o: { project: string; requestedBy: string; mcpConfigFile: string; sessionId: string | null }): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    JSON.stringify(LEADER_SETTINGS),
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--mcp-config",
    o.mcpConfigFile,
    "--append-system-prompt",
    leaderBrief(o.project, o.requestedBy),
    ...(o.sessionId ? ["--resume", o.sessionId] : []),
  ];
}

interface Finish {
  status: "done" | "failed";
  text: string;
  steps: string;
  sessionId: string | null;
  costUsd: number | null;
  error: RunRequestError | null;
}

export class ChatWorker {
  readonly #host: ChatHost;
  readonly #opts: Required<ChatOptions>;
  readonly #jobs = new Map<number, { stop: () => void }>();
  readonly #inflight = new Set<Promise<void>>();

  constructor(host: ChatHost, opts: ChatOptions) {
    this.#host = host;
    this.#opts = { progressMs: 2000, timeoutMinutes: 20, maxChats: 2, ...opts };
  }

  /** Replies being written now. */
  get active(): number {
    return this.#jobs.size;
  }

  /** Starts the replies not started yet, as many as there is room for; the hub sends the others again. */
  take(requests: ChatRequest[]): void {
    for (const req of requests) {
      if (this.#jobs.has(req.replyId)) continue;
      if (this.#jobs.size >= this.#opts.maxChats) return;
      this.#jobs.set(req.replyId, { stop: () => undefined });
      const job = this.#write(req).finally(() => this.#jobs.delete(req.replyId));
      this.#inflight.add(job);
      void job.finally(() => this.#inflight.delete(job));
    }
  }

  /** Resolves once every reply started so far has ended. For tests and quitting. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.stop();
  }

  #pick(pinned: string | null): AgentProfile | null {
    return (
      this.#host
        .profiles()
        .filter((p) => p.kind === "claude" && p.enabled && (!pinned || p.id === pinned) && !this.#host.unavailable?.(p.id))
        .sort((a, b) => a.priority - b.priority)[0] ?? null
    );
  }

  async #write(req: ChatRequest): Promise<void> {
    const machine = this.#host.machine();
    const refuse = (message: string, key?: string, vars?: Record<string, string | number>) =>
      this.#finish(req.replyId, { status: "failed", text: "", steps: "", sessionId: null, costUsd: null, error: { message, ...(key ? { key } : {}), ...(vars ? { vars } : {}) } });
    const profile = this.#pick(req.profileId);
    if (!profile) return refuse(`${machine} has no Claude profile it can start now.`, "errors.chatNoClaude", { machine, id: req.profileId ?? "claude" });
    const project = this.#host.projects().find((p) => p.name === req.project);
    if (!project) return refuse(`Project ${req.project} is not added to the app.`, "errors.projectNotAdded", { project: req.project });
    const hub = this.#host.hubUrl();
    if (!hub || !req.grant) return refuse("The hub sent no token for the leader; update the hub.", "errors.chatNoGrant");
    const base = this.#host.env();
    const bin = resolveBin(profile.bin, base.PATH ?? "");
    if (!bin) return refuse(`"${profile.bin}" is not on PATH.`, "runNote.binNotFound", { bin: profile.bin });

    // The token lives in a file only this user can read, gone with the reply.
    const dir = path.join(this.#opts.dataDir, "runs");
    mkdirSync(dir, { recursive: true });
    const mcpFile = path.join(dir, `chat-${req.replyId}.mcp.json`);
    const agent = `${profile.id}.${machine}`;
    const run = { agent, machine, project: req.project, task: `chat-${req.threadId}`, run: `chat-${req.replyId}`, readOnly: false };
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: claudeMcpServers({ url: hub, token: req.grant }, run) }), { mode: 0o600 });

    const hostEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_")));
    const env = { ...hostEnv, ...expandEnv(profile.env), HIVE_AGENT: profile.id, HIVE_PROJECT: req.project };
    const args = chatArgs({ project: req.project, requestedBy: req.requestedBy || "a project manager", mcpConfigFile: mcpFile, sessionId: req.sessionId });
    const stream = new ClaudeStream(project.repo);
    let steps = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    try {
      const child = spawn(bin, args, { cwd: project.repo, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.#jobs.set(req.replyId, { stop: () => killTree(child) });
      child.stdin.on("error", () => undefined);
      child.stdin.end(req.text);
      const out = new StringDecoder("utf8");
      child.stdout.on("data", (chunk: Buffer) => (steps = tail(steps + stream.push(out.write(chunk)))));
      child.stderr.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000)));
      const report = async () => {
        try {
          const res = await this.#host
            .backend()
            .call("chat.progress", { replyId: req.replyId, text: tail(stream.lastText ?? ""), steps, activity: stream.state.activity?.slice(0, 300) ?? null }, this.#host.actor());
          if (res.cancelled && !cancelled) {
            cancelled = true;
            killTree(child);
          }
        } catch {
          // The hub is away: the next report tries again; the reply fails there only after minutes of silence.
        }
      };
      await report();
      const tick = setInterval(() => void report(), this.#opts.progressMs);
      const limit = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.#opts.timeoutMinutes * 60_000);
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", (err) => {
          stderr = `${stderr}${err.message}`;
          resolve(-1);
        });
        child.on("close", (c) => resolve(c));
      });
      clearInterval(tick);
      clearTimeout(limit);
      steps = tail(steps + stream.end());

      const result = parseResult(stream.result);
      const text = result?.text ?? stream.lastText ?? "";
      const ok = code === 0 && result !== null && !result.isError && !timedOut;
      const hit = ok ? null : detectRateLimit(`${stderr}\n${steps}`);
      const error: RunRequestError | null = ok || cancelled
        ? null
        : timedOut
          ? { message: `Timed out after ${this.#opts.timeoutMinutes} minutes.`, key: "runNote.timedOut", vars: { minutes: this.#opts.timeoutMinutes } }
          : hit
            ? { message: hit.reason.slice(0, 2000) }
            : { message: stderr.trim().split("\n").at(-1)?.slice(0, 2000) || `Exited with code ${code}.`, ...(stderr.trim() ? {} : { key: "runNote.exited", vars: { code: String(code) } }) };
      await this.#finish(req.replyId, {
        status: ok || cancelled ? "done" : "failed",
        text,
        steps,
        sessionId: stream.sessionId,
        costUsd: result?.costUsd ?? null,
        error,
      });
    } catch (err) {
      await refuse(toErrorPayload(err).message);
    } finally {
      rmSync(mcpFile, { force: true });
    }
  }

  /** Told again a few times when the hub is away; after that the hub marks the reply as gone silent. */
  async #finish(replyId: number, f: Finish): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#host.backend().call("chat.finish", { replyId, ...f, text: tail(f.text), steps: tail(f.steps) }, this.#host.actor());
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Cancelled and finished meanwhile, or no such reply: nothing left to tell.
        if (code === "conflict" || code === "not_found" || code === "forbidden") return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

/** Claude Code's result event: the answer, whether it is an error, and its cost. */
function parseResult(line: string | null): { text: string | null; isError: boolean; costUsd: number | null } | null {
  if (!line) return null;
  try {
    const json = JSON.parse(line) as Record<string, unknown>;
    return {
      text: typeof json.result === "string" ? json.result : null,
      isError: json.is_error === true,
      costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : null,
    };
  } catch {
    return null;
  }
}
