// The leader of a project's web chat (roadmap 17): this machine writes the replies the hub hands it, with one of its
// Claude profiles, in the project's repo, resuming the thread's Claude Code session. The leader reaches Hive only
// through the hub's MCP with the reply's own token (the sender's rights, never more than this machine's), may read
// the repo but not change it, and reports as it goes so the web shows the reply while it is written.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { chatFileName, LEADER_COMMAND, toErrorPayload, type Actor, type AgentProfile, type ChatFile, type ChatRequest, type DesktopProject, type HiveBackend, type RunRequestError } from "@xdev-hive/core";
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
  /** Reads a file of the hub with a token (default: fetch); tests hand one of their own. */
  download?(url: string, token: string): Promise<Uint8Array>;
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
/**
 * The leader's permissions: the hub's MCP, and Bash only for the project's leader commands (roadmap 17i-2). In -p mode
 * anything not allowed is refused, a chained command too (checked with Claude Code 2.1.283); with no command Bash
 * is denied outright. It never edits or writes files.
 */
export function leaderSettings(commands: string[] = []) {
  const safe = commands.filter((c) => LEADER_COMMAND.test(c));
  return {
    disableAllHooks: true,
    permissions: {
      allow: ["mcp__xdev-hive", ...safe.map((c) => `Bash(${c}:*)`)],
      deny: [...(safe.length ? [] : ["Bash"]), "Edit", "Write", "MultiEdit", "NotebookEdit"],
    },
  };
}

export const leaderBrief = (project: string, who: string, commands: string[] = [], systems: Array<{ name: string; projects: string[] }> = []) =>
  [
    `You are the leader agent of project ${project} in xDev Hive, answering ${who} in the Hive web chat.`,
    "First read the team's guide with the xdev-hive tool skill_get, name hive-leader, and follow it.",
    "Work through the xdev-hive tools (tasks, runs, machines, docs, memory, skills). You may read this repository; you cannot change files.",
    commands.length
      ? `The only commands you may run are these, with any arguments, one at a time and never chained: ${commands.join(", ")}.`
      : "You cannot run commands.",
    "You change nothing yourself: tasks (propose_task, propose_task_status), runs, merges, machine plans and installs, the agent policy and stopping agents are proposals (the propose_* tools) a project manager confirms in the chat.",
    // Roadmap 19d: a feature that spans services is split into a task per service, with dependencies across them.
    ...systems.map(
      (s) =>
        `${project} is a service of system ${s.name} (${s.projects.join(", ")}). Its docs and memory are shared by them: doc_list and memory_search include them. ` +
        "For a feature that spans services, propose a task for each service (propose_task with project) and make one wait for another with dependsOn (service B waits for A's API).",
    ),
    "Propose a merge only when someone asked for it. When a decision is needed, ask with a few options instead of guessing.",
    "Reply in the language of the message, briefly, and say what you looked at and what you proposed.",
  ].join(" ");

interface FetchedFile {
  file: ChatFile;
  /** Where it is on this machine; null when it could not be fetched. */
  path: string | null;
  error?: string;
}

/** The hub's file, read with the reply's token. */
async function fetchBytes(url: string, token: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`The hub answered ${res.status} for ${url}.`);
  return new Uint8Array(await res.arrayBuffer());
}

/** What follows the message on stdin when it came with files: where they are, for the leader's Read tool. */
export function attachmentNote(files: FetchedFile[]): string {
  if (!files.length) return "";
  const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  return [
    "",
    "",
    "Files attached to this message (read them with the Read tool; it shows images and PDFs too):",
    ...files.map((f) => (f.path ? `- ${f.path} (${f.file.type}, ${size(f.file.size)})` : `- ${f.file.name}: could not be fetched (${f.error ?? "unknown error"})`)),
  ].join("\n");
}

/** The CLI's arguments; the message itself goes in on stdin, so one starting with "-" is never read as an option. */
export function chatArgs(o: {
  project: string;
  requestedBy: string;
  mcpConfigFile: string;
  sessionId: string | null;
  fileDir?: string;
  /** The thread's model and effort; left out, the profile's own. */
  model?: string | null;
  effort?: string | null;
  /** The project's leader commands (Bash prefixes); none, no Bash. */
  commands?: string[];
  /** The systems the project is a service of (roadmap 19d). */
  systems?: Array<{ name: string; projects: string[] }>;
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    JSON.stringify(leaderSettings(o.commands)),
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--mcp-config",
    o.mcpConfigFile,
    // The message's files, outside the repo: the leader's file tools may read them there. The next word is an option,
    // so the list of directories ends here.
    ...(o.fileDir ? ["--add-dir", o.fileDir] : []),
    "--append-system-prompt",
    leaderBrief(o.project, o.requestedBy, o.commands, o.systems),
    ...(o.model ? ["--model", o.model] : []),
    ...(o.effort ? ["--effort", o.effort] : []),
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

    // The message's files, fetched with the reply's token into a folder of this reply, gone with it.
    const fileDir = req.files?.length ? path.join(dir, `chat-${req.replyId}-files`) : null;
    const fetched = fileDir ? await this.#fetchFiles(req.files!, fileDir, hub, req.grant) : [];
    const hostEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_")));
    const env = { ...hostEnv, ...expandEnv(profile.env), HIVE_AGENT: profile.id, HIVE_PROJECT: req.project };
    const args = chatArgs({
      project: req.project,
      requestedBy: req.requestedBy || "a project manager",
      mcpConfigFile: mcpFile,
      sessionId: req.sessionId,
      ...(fileDir ? { fileDir } : {}),
      model: req.model ?? null,
      effort: req.effort ?? null,
      commands: req.commands ?? [],
      systems: req.systems ?? [],
    });
    const stream = new ClaudeStream(project.repo);
    let steps = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    try {
      const child = spawn(bin, args, { cwd: project.repo, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.#jobs.set(req.replyId, { stop: () => killTree(child) });
      child.stdin.on("error", () => undefined);
      child.stdin.end(req.text + attachmentNote(fetched));
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
      if (fileDir) rmSync(fileDir, { recursive: true, force: true });
    }
  }

  /** Each file written under a safe, distinct name; one the hub would not give is noted, and the reply goes on. */
  async #fetchFiles(files: ChatFile[], dir: string, hub: string, token: string): Promise<FetchedFile[]> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const download = this.#host.download ?? fetchBytes;
    const used = new Set<string>();
    const out: FetchedFile[] = [];
    for (const f of files) {
      // The hub cleaned the name already; this machine does not rely on it.
      let name = chatFileName(f.name);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${n}-${chatFileName(f.name)}`;
      used.add(name.toLowerCase());
      try {
        const bytes = await download(`${hub.replace(/\/+$/, "")}/api/chat/files/${f.id}`, token);
        const file = path.join(dir, name);
        writeFileSync(file, bytes, { mode: 0o600 });
        out.push({ file: f, path: file });
      } catch (err) {
        out.push({ file: f, path: null, error: toErrorPayload(err).message });
      }
    }
    return out;
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
export function parseResult(line: string | null): { text: string | null; isError: boolean; costUsd: number | null } | null {
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
