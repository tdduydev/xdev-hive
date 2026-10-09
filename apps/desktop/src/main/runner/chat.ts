// The leader of a project's web chat (roadmap 17): this machine writes the replies the hub hands it, with one of its
// Claude or Codex profiles, in the project's repo, resuming the thread's own CLI session. The leader reaches Hive only
// through the hub's MCP with the reply's own token (the sender's rights, never more than this machine's), may read
// the repo but not change it, and reports as it goes so the web shows the reply while it is written.
// In local mode (roadmap 48) the chat is this machine's own: its database hands the replies, and the leader reaches it
// through the app's hive-mcp shim, told which reply it writes so it gets the leader's proposals and not the board.
import { spawnCli } from "#desktop/main/spawn-cli.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { chatFileName, HUB_SCOPE, LEADER_COMMAND, toErrorPayload, type Actor, type AgentProfile, type ChatFile, type ChatRequest, type DesktopProject, type HiveBackend, type RunRequestError } from "@xdev-hive/core";
import { NO_FEATURES, runMcpServers } from "#desktop/main/installer.ts";
import { expandEnv, resolveBin } from "./command.ts";
import { claudeMcpServers } from "./container-mcp.ts";
import { killTree } from "./kill.ts";
import { detectRateLimit, type RateLimitHit } from "./rate-limit.ts";
import { ClaudeStream, CodexStream } from "./stream.ts";
import { hubHeaders } from "./container-mcp.ts";
import { leaderRepoScript } from "./leader-repo.ts";

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
  quotaUnavailable?(profileId: string): boolean;
  rateLimited?(profile: AgentProfile, hit: RateLimitHit): Promise<void>;
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
    // Roadmap 60d: a request to build something becomes one plan the person starts with a single click.
    "For a request to build or change something, propose one plan (propose_plan): a short spec at a new key project/<service>/<slug> (or system/<system>/<slug> when it spans services), tasks each with what done means and dependsOn, and the batches you expect them to land in. " +
      "Ask back only for a real decision: design direction, dropping a requirement, widening permissions or touching production. Otherwise report progress in this thread from task_list and run_list: which batch landed, which is being checked, which task is blocked.",
    `You change nothing yourself: tasks (propose_task, propose_task_status), runs, merges, machine plans and installs, the agent policy and stopping agents are proposals (the propose_* tools) ${project === HUB_SCOPE ? "a hub admin" : "a project manager"} confirms in the chat.`,
    // Roadmap 19d: a feature that spans services is split into a task per service, with dependencies across them.
    ...systems.map(
      (s) =>
        `${project} is a service of system ${s.name} (${s.projects.join(", ")}). Its docs and memory are shared by them: doc_list and memory_search include them. ` +
        `For a feature that spans services, propose one plan with a spec at system/${s.name}/<slug> and a task for each service (its project), and make one wait for another with dependsOn (service B waits for A's API).`,
    ),
    "For research, use propose_research: topic, questions, scope (service/system/hub), source categories (repo/hive/web), and format (brief/comparison/tasks). Research runs read-only and returns an artifact and a draft doc. Turn recommendations into work only through propose_plan after the person asks for a plan.",
    "Chat shortcuts are editable requests, not authorization to execute: /assign asks for a Plan via propose_plan; /research asks for research (use propose_research for a research.start proposal only if supported; otherwise explain that research runs are unavailable); /release asks to inspect the merge queue and release readiness, then propose next steps; /cancel <run> asks to check and propose cancelling that run; /retry <run> asks to check the cause and propose redispatch. Resolve the exact run and service first; if ambiguous, ask. Never cancel, redispatch, merge or release directly.",
    "For /status read current tasks, runs, pipeline and machine quota in the thread's scope. Summarize done, running, awaiting review, blocked and quota, with links to tasks, runs, pipeline and quota. The chat UI attaches a live status card with verified counters to your reply; complement that card with items needing attention. Do not invent numbers or claim an unavailable capability ran.",
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

/** Full table overrides keep personal/repo MCP servers out of the leader, as Claude's strict config does. */
export function codexChatArgs(o: {
  sessionId: string | null; servers: Record<string, unknown>; brief: string; model?: string | null; effort?: string | null;
}): string[] {
  const toml = (v: unknown): string => Array.isArray(v) ? `[${v.map(toml).join(",")}]`
    : v && typeof v === "object" ? `{${Object.entries(v).map(([k, value]) => `${JSON.stringify(k)}=${toml(value)}`).join(",")}}` : JSON.stringify(v);
  return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check",
    "-c", 'approval_policy="never"', "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
    "-c", "features.js_repl=false", "-c", "features.collab=false", "-c", "features.multi_agent=false", "-c", "features.apps=false",
    // hooks.json can load independently of the inline table; disable its feature as well.
    "-c", "features.hooks=false", "-c", "features.codex_hooks=false",
    "-c", "plugins={}", "-c", "hooks={}", "-c", 'web_search="disabled"',
    "-c", `mcp_servers=${toml(o.servers)}`, "-c", `developer_instructions=${JSON.stringify(o.brief)}`,
    ...(o.model ? ["--model", o.model] : []), ...(o.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(o.effort)}`] : []),
    ...(o.sessionId ? ["resume", o.sessionId] : []), "-",
  ];
}

interface Finish {
  status: "done" | "failed";
  text: string;
  steps: string;
  sessionId: string | null;
  costUsd: number | null;
  error: RunRequestError | null;
  profileId?: string;
  tokens?: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | null;
  rateLimited?: boolean;
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
        .filter((p) => ["claude", "codex"].includes(p.kind) && p.enabled && (!pinned || p.id === pinned) && !this.#host.unavailable?.(p.id))
        .sort((a, b) => a.priority - b.priority)[0] ?? null
    );
  }

  async #write(req: ChatRequest): Promise<void> {
    const machine = this.#host.machine();
    const refuse = async (message: string, key?: string, vars?: Record<string, string | number>) => {
      await this.#finish(req.replyId, { status: "failed", text: "", steps: "", sessionId: null, costUsd: null, error: { message, ...(key ? { key } : {}), ...(vars ? { vars } : {}) } });
      this.#ended(req, "failed");
    };
    const pinned = this.#host.profiles().find((p) => p.id === req.profileId);
    // Availability can change after the heartbeat. Only a subsequent reply may fall back; never retry this turn.
    const profile = this.#pick(req.profileId) ?? (pinned?.kind === "claude" && this.#host.quotaUnavailable?.(pinned.id) ? this.#host.profiles().filter((p) => p.kind === "codex" && p.enabled && !this.#host.unavailable?.(p.id)).sort((a, b) => a.priority - b.priority)[0] : null);
    if (!profile) return refuse(`${machine} has no Claude or Codex profile it can start now.`, "errors.chatNoProfile", { machine, id: req.profileId ?? "Claude / Codex" });
    const codex = profile.kind === "codex";
    const switched = !!req.profileId && profile.id !== req.profileId;
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
    const fileDir = req.files?.length ? path.join(dir, `chat-${req.replyId}-files`) : null;
    const repoScript = codex ? path.join(dir, `chat-${req.replyId}-repo.mjs`) : null;
    try {
      if (!codex) writeFileSync(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });

      // The message's files, fetched with the reply's token (or read from this machine's database) into a folder of
      // this reply, gone with it.
      const download = this.#host.download ?? fetchBytes;
      const read = (f: ChatFile): Promise<Uint8Array> => {
        if (hub && grant) return download(`${hub.replace(/\/+$/, "")}/api/chat/files/${f.id}`, grant);
        const bytes = this.#host.localFile?.(f.id);
        return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`No file #${f.id} in this machine's database.`));
      };
      const fetched = fileDir ? await this.#fetchFiles(req.files!, fileDir, read) : [];
      const hostEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_")));
      const env = { ...hostEnv, ...expandEnv(profile.env), HIVE_AGENT: profile.id, HIVE_PROJECT: req.project, ...(codex && grant ? { HIVE_CHAT_TOKEN: grant } : {}) };
      const sessionId = switched ? null : req.sessionId;
      if (hubScope) mkdirSync(cwd, { recursive: true });
      if (repoScript) writeFileSync(repoScript, leaderRepoScript({ cwd, roots: [...(hubScope ? repos.map((p) => p.repo) : [cwd]), ...(fileDir ? [fileDir] : [])], commands: req.commands ?? [], ...(hubScope ? { repos: repos.map((p) => p.repo) } : {}) }), { mode: 0o600 });
      const modelFlag = profile.args.findIndex((a) => a === "-m" || a === "--model");
      const configString = (key: string) => {
        const override = profile.args.find((a, i) => i > 0 && profile.args[i - 1] === "-c" && a.startsWith(`${key}=`))?.slice(key.length + 1);
        if (!override) return null;
        try { const value: unknown = JSON.parse(override); return typeof value === "string" ? value : null; } catch { return null; }
      };
      const profileModel = modelFlag >= 0 ? profile.args[modelFlag + 1] : profile.args.find((a) => a.startsWith("--model="))?.slice(8) ?? configString("model");
      const model = (switched ? null : req.model) ?? profileModel;
      const args = codex ? codexChatArgs({
        sessionId, model, effort: (switched ? null : req.effort) ?? configString("model_reasoning_effort"),
        brief: leaderBrief(req.project, req.requestedBy || "a project manager", leaderCommands(req.commands ?? [], hubScope ? repos : undefined), req.systems, req.projects, hubScope ? repos : []) + " Use leader-repo read_file and list_directory to read repositories and attachments; use its command tool for permitted commands. The built-in shell is disabled.",
        servers: {
          ...(hub && grant ? { "xdev-hive": { url: `${hub.replace(/\/+$/, "")}/mcp`, bearer_token_env_var: "HIVE_CHAT_TOKEN", http_headers: hubHeaders(run), default_tools_approval_mode: "approve", required: true } }
            : Object.fromEntries(Object.entries(mcpServers).map(([key, value]) => [key, { ...(value as object), default_tools_approval_mode: "approve", required: true }]))),
          "leader-repo": { command: process.execPath, args: [repoScript!], env: { ELECTRON_RUN_AS_NODE: "1" }, default_tools_approval_mode: "approve", required: true },
        },
      }) : chatArgs({
        project: req.project,
        requestedBy: req.requestedBy || "a project manager",
        mcpConfigFile: mcpFile,
        sessionId,
        ...(fileDir ? { fileDir } : {}),
        model: req.model ?? null,
        effort: req.effort ?? null,
        commands: req.commands ?? [],
        systems: req.systems ?? [],
        projects: req.projects,
        ...(hubScope ? { repos } : {}),
      });
      const stream = codex ? new CodexStream(cwd) : new ClaudeStream(cwd);
      let steps = "";
      let stderr = "";
      let cancelled = false;
      let timedOut = false;
      const child = spawnCli(bin, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.#jobs.set(req.replyId, { stop: () => killTree(child) });
      child.stdin.on("error", () => undefined);
      child.stdin.end((!sessionId && req.history ? `Previous conversation in Hive (context only; earlier proposals remain in Hive, do not repeat them):\n${req.history}\n\nCurrent message:\n` : "") + req.text + attachmentNote(fetched));
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

      const result = stream instanceof ClaudeStream ? parseResult(stream.result) : stream.tokens.turns ? { text: stream.lastText, isError: stream.failed, costUsd: null } : null;
      const text = result?.text ?? stream.lastText ?? "";
      const ok = code === 0 && result !== null && !result.isError && !timedOut;
      const hit = ok || cancelled || timedOut ? null : detectRateLimit(`${stderr}\n${steps}\n${text}`);
      if (hit) await this.#host.rateLimited?.(profile, hit);
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
        sessionId: stream instanceof CodexStream ? stream.threadId ?? sessionId : stream.sessionId,
        costUsd: result?.costUsd ?? null,
        profileId: profile.id,
        rateLimited: !!hit,
        tokens: stream instanceof CodexStream ? stream.tokens.turns ? { inputTokens: Math.max(0, stream.tokens.input - stream.tokens.cached), cacheReadTokens: stream.tokens.cached, outputTokens: stream.tokens.output } : null : claudeTokens(stream.result),
        error,
      });
      // Whoever stopped it knows already.
      if (!cancelled) this.#ended(req, ok ? "done" : "failed");
    } catch (err) {
      await refuse(toErrorPayload(err).message);
    } finally {
      rmSync(mcpFile, { force: true });
      if (repoScript) rmSync(repoScript, { force: true });
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

function claudeTokens(line: string | null): Finish["tokens"] {
  if (!line) return null;
  try {
    const u = JSON.parse(line).usage;
    if (!u) return null;
    const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return { inputTokens: n(u.input_tokens), cacheReadTokens: n(u.cache_read_input_tokens), outputTokens: n(u.output_tokens) };
  } catch { return null; }
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
