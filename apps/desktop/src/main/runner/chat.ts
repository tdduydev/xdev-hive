// The leader of a project's web chat (roadmap 17): this machine writes the replies the hub hands it, with one of its
// Claude profiles, in the project's repo, resuming the thread's Claude Code session. The leader reaches Hive only
// through the hub's MCP with the reply's own token (the sender's rights, never more than this machine's), may read
// the repo but not change it, and reports as it goes so the web shows the reply while it is written.
// In local mode (roadmap 48) the chat is this machine's own: its database hands the replies, and the leader reaches it
// through the app's hive-mcp shim, told which reply it writes so it gets the leader's proposals and not the board.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { chatFileName, HUB_SCOPE, LEADER_COMMAND, toErrorPayload, type Actor, type AgentProfile, type ChatFile, type ChatRequest, type DesktopProject, type HiveBackend, type RunRequestError } from "@xdev-hive/core";
import { NO_FEATURES, runMcpServers } from "#desktop/main/installer.ts";
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
  /** The chat is this machine's own database's (local mode): no hub, no reply token. */
  local?(): boolean;
  /** Local mode: a message's file, from the database. */
  localFile?(id: number): Uint8Array | null;
  /** A reply this machine wrote ended (the app tells its user when the window is hidden). */
  onFinished?(req: ChatRequest, status: "done" | "failed"): void;
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
function leaderCommands(commands: string[], repos?: DesktopProject[]): string[] {
  const safe = commands.filter((c) => LEADER_COMMAND.test(c));
  // The hub's cwd is outside every repo: git must name its repo without granting cd or chained shell commands.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return repos ? safe.flatMap((c) => c.startsWith("git ") ? repos.map((p) => `git -C ${quote(p.repo)} ${c.slice(4)}`) : [c]) : safe;
}

export function leaderSettings(commands: string[] = [], repos?: DesktopProject[]) {
  const safe = leaderCommands(commands, repos);
  return {
    disableAllHooks: true,
    permissions: {
      allow: ["mcp__xdev-hive", ...safe.map((c) => `Bash(${c}:*)`)],
      deny: [...(safe.length ? [] : ["Bash"]), "Edit", "Write", "MultiEdit", "NotebookEdit"],
    },
  };
}

export const leaderBrief = (project: string, who: string, commands: string[] = [], systems: Array<{ name: string; projects: string[] }> = [], projects: ChatRequest["projects"] = [], repos: DesktopProject[] = []) =>
  [
    project === HUB_SCOPE
      ? `You are the hub-wide leader agent in xDev Hive, answering hub admin ${who} in the Hive web chat. Your scope is the whole hub, across services and machines.`
      : `You are the leader agent of project ${project} in xDev Hive, answering ${who} in the Hive web chat.`,
    "First read the team's guide with the xdev-hive tool skill_get, name hive-leader, and follow it.",
    ...(project === HUB_SCOPE ? [
      "Read project_list and alert_list first. There is no default project: always name project in project-specific reads and proposals. Group work by service; leave merges, stopping agents and policy decisions to the hub admin.",
      `Services known to the hub: ${JSON.stringify(projects)}. Each entry names its systems and machines with a repo.`,
      `Repositories on this machine: ${JSON.stringify(repos)}. Run each command for an explicitly named repository; use the permitted git -C prefix for git, never cd or chained commands. A service without a local repo is managed through Hive tools.`,
    ] : []),
    `Work through the xdev-hive tools (tasks, runs, machines, docs, memory, skills). You may read ${project === HUB_SCOPE ? "the repositories added to this chat" : "this repository"}; you cannot change files.`,
    commands.length
      ? `The only commands you may run are these, with any arguments, one at a time and never chained: ${commands.join(", ")}.`
      : "You cannot run commands.",
    `You change nothing yourself: tasks (propose_task, propose_task_status), runs, merges, machine plans and installs, the agent policy and stopping agents are proposals (the propose_* tools) ${project === HUB_SCOPE ? "a hub admin" : "a project manager"} confirms in the chat.`,
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
  projects?: ChatRequest["projects"];
  /** All this machine's repos, only for a hub-wide thread. */
  repos?: DesktopProject[];
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    JSON.stringify(leaderSettings(o.commands, o.repos)),
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--mcp-config",
    o.mcpConfigFile,
    // The message's files, outside the repo: the leader's file tools may read them there. The next word is an option,
    // so the list of directories ends here.
    ...((o.fileDir || o.repos?.length) ? ["--add-dir", ...new Set([...(o.fileDir ? [o.fileDir] : []), ...(o.repos ?? []).map((p) => p.repo)])] : []),
    "--append-system-prompt",
    leaderBrief(o.project, o.requestedBy, leaderCommands(o.commands ?? [], o.repos), o.systems, o.projects, o.repos),
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
    const refuse = async (message: string, key?: string, vars?: Record<string, string | number>) => {
      await this.#finish(req.replyId, { status: "failed", text: "", steps: "", sessionId: null, costUsd: null, error: { message, ...(key ? { key } : {}), ...(vars ? { vars } : {}) } });
      this.#ended(req, "failed");
    };
    const profile = this.#pick(req.profileId);
    if (!profile) return refuse(`${machine} has no Claude profile it can start now.`, "errors.chatNoClaude", { machine, id: req.profileId ?? "claude" });
    const hubScope = req.project === HUB_SCOPE;
    const repos = this.#host.projects();
    const project = repos.find((p) => p.name === req.project);
    if (!hubScope && !project) return refuse(`Project ${req.project} is not added to the app.`, "errors.projectNotAdded", { project: req.project });
    const cwd = hubScope ? path.join(this.#opts.dataDir, "chat-hub") : project!.repo;
    const local = this.#host.local?.() === true;
    const hub = local ? null : this.#host.hubUrl();
    const grant = req.grant;
    if (!local && (!hub || !grant)) return refuse("The hub sent no token for the leader; update the hub.", "errors.chatNoGrant");
    const base = this.#host.env();
    const bin = resolveBin(profile.bin, base.PATH ?? "");
    if (!bin) return refuse(`"${profile.bin}" is not on PATH.`, "runNote.binNotFound", { bin: profile.bin });

    // The token lives in a file only this user can read, gone with the reply.
    const dir = path.join(this.#opts.dataDir, "runs");
    mkdirSync(dir, { recursive: true });
    const mcpFile = path.join(dir, `chat-${req.replyId}.mcp.json`);
    const agent = `${profile.id}.${machine}`;
    const run = { agent, machine, project: req.project, task: `chat-${req.threadId}`, run: `chat-${req.replyId}`, readOnly: false };
    const mcpServers = hub && grant
      ? claudeMcpServers({ url: hub, token: grant }, run)
      : runMcpServers(profile.id, req.project, NO_FEATURES, { task: run.task, id: run.run, chatReply: req.replyId });
    writeFileSync(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });

    // The message's files, fetched with the reply's token (or read from this machine's database) into a folder of
    // this reply, gone with it.
    const fileDir = req.files?.length ? path.join(dir, `chat-${req.replyId}-files`) : null;
    const download = this.#host.download ?? fetchBytes;
    const read = (f: ChatFile): Promise<Uint8Array> => {
      if (hub && grant) return download(`${hub.replace(/\/+$/, "")}/api/chat/files/${f.id}`, grant);
      const bytes = this.#host.localFile?.(f.id);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`No file #${f.id} in this machine's database.`));
    };
    const fetched = fileDir ? await this.#fetchFiles(req.files!, fileDir, read) : [];
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
      projects: req.projects,
      ...(hubScope ? { repos } : {}),
    });
    const stream = new ClaudeStream(cwd);
    let steps = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    try {
      if (hubScope) mkdirSync(cwd, { recursive: true });
      const child = spawn(bin, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
      // Whoever stopped it knows already.
      if (!cancelled) this.#ended(req, ok ? "done" : "failed");
    } catch (err) {
      await refuse(toErrorPayload(err).message);
    } finally {
      rmSync(mcpFile, { force: true });
      if (fileDir) rmSync(fileDir, { recursive: true, force: true });
    }
  }

  #ended(req: ChatRequest, status: "done" | "failed"): void {
    try {
      this.#host.onFinished?.(req, status);
    } catch {
      // A notice that could not be shown changes nothing about the reply.
    }
  }

  /** Each file written under a safe, distinct name; one the hub would not give is noted, and the reply goes on. */
  async #fetchFiles(files: ChatFile[], dir: string, read: (f: ChatFile) => Promise<Uint8Array>): Promise<FetchedFile[]> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const used = new Set<string>();
    const out: FetchedFile[] = [];
    for (const f of files) {
      // The hub cleaned the name already; this machine does not rely on it.
      let name = chatFileName(f.name);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${n}-${chatFileName(f.name)}`;
      used.add(name.toLowerCase());
      try {
        const bytes = await read(f);
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
