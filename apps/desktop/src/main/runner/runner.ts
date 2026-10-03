// Runs coding-agent CLIs headless against Hive tasks and rotates subscriptions when one runs out of quota.
//
//   queued ──pick profile──▶ running ──exit 0──▶ succeeded ──(reviewAfter)──▶ review run on another vendor
//                               │ ├─ quota message ─▶ rate_limited ─▶ cooldown profile, new attempt elsewhere
//                               │ ├─ CLI missing ──▶ failed ─────────▶ short cooldown, new attempt elsewhere
//                               │ └─ other ────────▶ failed / cancelled
//
// Best-of-n: 2–4 candidates (each on its own subscription and branch ai/<task>+c<n>) ──all done──▶ judge on
// another vendor ──"Winner: c<n>"──▶ that branch becomes ai/<task> ──▶ review / MR as after one implement run.
//
// No Electron imports: the desktop main process provides a RunnerHost, tests provide a fake one.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheReadShare,
  AGENT_ROLES,
  agentActorName,
  effectivePolicy,
  HiveError,
  MAX_CANDIDATES,
  OPEN_POLICY,
  PAUSED_HUB,
  profileAutonomy,
  redactLines,
  stripHidden,
  syncOutcome,
  toErrorPayload,
  usageHeadroom,
  usageStop,
  type Actor,
  type AgentKind,
  type AgentPolicy,
  type AgentProfile,
  type AgentProfileStatus,
  type AgentRun,
  type AgentsPaused,
  type BestOf,
  type BudgetBlock,
  type CiFix,
  type DesktopProject,
  type CommandStatus,
  type HiveBackend,
  type LoginStatus,
  type PlanUsage,
  type MachineCommand,
  type MachineTools,
  type ProfileChange,
  type RunMergeOrder,
  type RunMr,
  type QuotaCooldown,
  type ReportedProfile,
  type RunCancel,
  type RunRequest,
  type RunRequestError,
  type SetupReport,
  type TeamPolicy,
  type RunnerSettings,
  type RunStatus,
  type StartRunRequest,
  type SyncReport,
  type Task,
  type UpdateOffer,
} from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";
import { git, isGitRepo } from "#desktop/main/git.ts";
import { NO_FEATURES, repoFeatures } from "#desktop/main/installer.ts";
import { renderContext } from "#desktop/main/sync.ts";
import { legacyPick, NO_TOOLS, prepareTool, runTools, toolDirs, type ToolPick } from "./tools.ts";
import { containerCommand } from "./container.ts";
import { claudeMcpServers, codexMcpArgs, hubMcpEnv, type McpRun } from "./container-mcp.ts";
import { deniedHosts, egressAllow, egressPlan, type Egress } from "./egress.ts";
import {
  applyPolicy,
  buildCommand,
  buildPrompt,
  codexMcpNames,
  describeCommand,
  expandEnv,
  expandHome,
  parsePick,
  policyBlocks,
  policyLine,
  resolveBin,
  type JudgeCandidate,
} from "./command.ts";
import { detectRateLimit } from "./rate-limit.ts";
import { AssistWorker } from "./assist.ts";
import { ChatWorker } from "./chat.ts";
import { killTree } from "./kill.ts";
import { ClaudeStream, CodexStream, lineStamper } from "./stream.ts";
import { parseClaudeResult, type RunUsage } from "./usage.ts";
import { pickProfile, waitingReason, type ProfileLoad, type RunNeeds } from "./schedule.ts";
import { ACTIVE, RunStore } from "./store.ts";
import {
  branchFor,
  branchState,
  candidateName,
  commitAll,
  branchPatch,
  ensureWorktree,
  hasBranch,
  remoteStart,
  removeWorktree,
  resetTo,
  type Worktree,
} from "./worktree.ts";

export interface RunnerHost {
  backend(): HiveBackend;
  /** Reads a file of the hub with a token (chat attachments); fetch when left out. */
  download?(url: string, token: string): Promise<Uint8Array>;
  profiles(): AgentProfile[];
  settings(): RunnerSettings;
  projects(): DesktopProject[];
  mode(): "local" | "hub";
  /** This machine's name in hub leases (config.machine). */
  machine(): string;
  /** Base env for agent processes (login-shell PATH etc.). */
  env(): NodeJS.ProcessEnv;
  /** What the heartbeat tells the hub besides runs: the last setup check and this machine's profiles. */
  report?(): { setup?: { checkedAt: string; report: SetupReport }; profiles?: ReportedProfile[] };
  /** The last sign-in check of a profile's CLI (see login.ts). */
  login?(profileId: string): LoginStatus | undefined;
  /** The profile's plan usage from the same check. */
  usage?(profileId: string): PlanUsage | undefined;
  /** Hub mode: where a container run's agent reaches Hive (the hub's HTTP MCP) and with which token. */
  hub?(): { url: string; token: string } | null;
  /** The profile's long-lived token for container runs (Claude Code), if one is saved. */
  token?(profileId: string): string | undefined;
  /** The team's GitLab (its URL), which a restricted container may reach. */
  gitlab?(): string | null;
  /** The hub tools this machine's user allowed, by id: the toolHash they allowed (config.toolTrust). */
  toolTrust?(): Record<string, string>;
}

/** What the hub sent back on the last heartbeat. */
export interface HubUpdate {
  duplicate: boolean;
  policy: TeamPolicy;
  /** Install requests from an admin waiting for this machine's user. */
  commands: MachineCommand[];
  /** Sync requests the runner takes by itself (roadmap 22n); a hub older than them sends none. */
  syncCommands: MachineCommand[];
  /** A newer app build the hub's rollout offers this machine (roadmap 22i); a hub without updates sends none. */
  update?: UpdateOffer | null;
  /** The agent policy (roadmap 27a): the hub's default and the parts of this machine's projects; a hub older than it sends none. */
  agentPolicy?: HubAgentPolicy | null;
  /** The tool catalog for this machine's projects (roadmap 28b); a hub older than it sends none. */
  tools?: MachineTools | null;
  /** Profile changes asked for on the web (roadmap 18d); a hub older than them sends none. */
  profileChanges?: ProfileChange[];
  /** Merges asked for on the web (roadmap 18c), while this machine takes runs from the hub. */
  mergeRuns?: RunMergeOrder[];
}

/** What the MR watcher saw of a run's MR, as the hub keeps it (roadmap 18c); null without an MR. */
const mrOf = (r: AgentRun): RunMr | null =>
  r.mrUrl ? { iid: r.mrIid, status: r.mrStatus, draft: r.mrDraft, pipeline: r.pipelineStatus, pipelineUrl: r.pipelineUrl, checkedAt: r.mrCheckedAt } : null;

export type HubAgentPolicy = { hub: AgentPolicy; projects: Record<string, Partial<AgentPolicy>> };

export type RunnerEvent =
  | { type: "finished"; run: AgentRun }
  | { type: "rotated"; run: AgentRun; next: AgentRun }
  | { type: "follow-up"; run: AgentRun; next: AgentRun }
  /** Best-of-n: every candidate is done and a judge is queued. */
  | { type: "judging"; run: AgentRun; next: AgentRun }
  /** Best-of-n: `run` is the kept candidate (now on ai/<task>); `next` its review, if any. */
  | { type: "picked"; run: AgentRun; next: AgentRun | null }
  /** Best-of-n: the judge chose nothing usable; someone picks a candidate in the app. */
  | { type: "undecided"; run: AgentRun }
  /** A project manager queued this run for this machine on the web (runs.dispatch). */
  | { type: "dispatched"; run: AgentRun; by: string };

export interface RunnerOptions {
  /** Holds runs.db, run logs and (by default) worktrees. */
  dataDir: string;
  user?: string;
  now?: () => Date;
  onEvent?: (event: RunnerEvent) => void;
  tickMs?: number;
  /** Hub mode: how often to report runs and refresh shared quota cooldowns. */
  heartbeatMs?: number;
  /** Hub mode: how often to push runs that changed (status, current step, the end of the log) for the web. */
  pushMs?: number;
  /** Hub mode, taking runs from the hub: how often to ask for chat replies to write (0: only at heartbeats). */
  chatPollMs?: number;
  /** How often a chat reply being written is reported to the hub. */
  chatProgressMs?: number;
  /** How often to ask for the Docs writing assistant's asks (0: never by itself; see pollAssists). */
  assistPollMs?: number;
  /** App version shown on the hub's machine list. */
  version?: string;
  /** Rest for a profile whose CLI is missing, so rotation skips it for a while. */
  unavailableCooldownMinutes?: number;
  /**
   * Called for every finished run before follow-ups are queued (e.g. open a merge request).
   * Returned fields are saved on the run. Errors are recorded on the run, never fail it.
   */
  afterFinish?: (run: AgentRun) => Promise<Partial<AgentRun> | void>;
  /** After a finished run was pushed to the hub (hub mode): what the hub should learn after the run's end. */
  afterReport?: (run: AgentRun) => Promise<void>;
  /** Called after every successful heartbeat. */
  onHub?: (update: HubUpdate) => void;
  /**
   * Hub mode: syncs a project as the Projects page's Đồng bộ does (context into the repo, the repo's docs into Hive),
   * for a sync request from the Context agent page (roadmap 22n). Without it, sync requests are left to expire.
   */
  sync?: (project: DesktopProject) => Promise<SyncReport>;
}

interface Live {
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  /** A container run: killing the docker client does not stop the container. */
  container?: { docker: string; name: string; env: NodeJS.ProcessEnv };
}

/** One docker command; rejects with the last line it wrote to stderr. */
function dockerRun(docker: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(docker, args, { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split("\n").at(-1) || err.message));
      else resolve(`${stdout}${stderr}`);
    });
  });
}

/** Stops a run's process, and its container when it has one. */
function stopLive(live: Live): void {
  killTree(live.child);
  // Same environment as the run's docker (DOCKER_HOST, contexts…).
  if (live.container) spawn(live.container.docker, ["kill", live.container.name], { env: live.container.env, stdio: "ignore", windowsHide: true }).on("error", () => undefined);
}

type Outcome =
  | {
      kind: "exit";
      code: number | null;
      stdout: string;
      all: string;
      cancelled: boolean;
      timedOut: boolean;
      usage?: RunUsage | null;
      /** Hosts the restricted network refused (from the proxy's log). */
      blocked?: string[];
    }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; reason: string };

const TAIL_BYTES = 20_000;
/** Claude Code's JSON result is one line holding the whole final message: keep more of it. */
const JSON_BYTES = 2_000_000;
const keepTail = (s: string, max = TAIL_BYTES) => (s.length > max ? s.slice(-max) : s);
const clip = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);
const TERMINAL: RunStatus[] = ["succeeded", "failed", "rate_limited", "cancelled"];

/** The latest attempt of each candidate of a group (a rotation adds a run), in candidate order. */
function latestCandidates(group: AgentRun[]): AgentRun[] {
  const by = new Map<number, AgentRun>();
  for (const r of group) if (r.bestOf && r.bestOf.n > 0) by.set(r.bestOf.n, r);
  return [...by.values()].sort((a, b) => a.bestOf!.n - b.bestOf!.n);
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}


export class Runner {
  readonly store: RunStore;
  readonly #host: RunnerHost;
  /** CLIs being upgraded (roadmap 33): their profiles take no new run until it is done. */
  readonly #held = new Set<AgentKind>();
  readonly #opts: Required<Omit<RunnerOptions, "onEvent" | "afterFinish" | "afterReport" | "onHub" | "sync">> &
    Pick<RunnerOptions, "onEvent" | "afterFinish" | "afterReport" | "onHub" | "sync">;
  /** Sync requests taken (roadmap 22n): the hub sends one until it hears "running", which may cross a heartbeat. */
  readonly #syncsTaken = new Set<number>();
  readonly #syncs = new Set<Promise<void>>();
  readonly #live = new Map<string, Live>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #waiting = new Map<string, string>();
  /** Runs between their end and the last of their bookkeeping (see AgentRun.finishing). */
  readonly #finishing = new Set<string>();
  /** Why a run was stopped, when not from the Board here (a project manager on the web). */
  readonly #cancelNotes = new Map<string, string>();
  /** Runs cancelled while #execute was still setting them up, before there was a process to kill. */
  readonly #stopping = new Set<string>();
  /** What each running agent is doing now (see AgentRun.activity). */
  readonly #activity = new Map<string, string>();
  /** Lease holder name as the backend recorded it (a hub appends the token name: claude-1.duy-mbp@duy). */
  readonly #owners = new Map<string, string>();
  /** Hub cooldowns by account, refreshed by every heartbeat. */
  #shared = new Map<string, QuotaCooldown>();
  /** Full spending caps (roadmap 27b), refreshed by every heartbeat: queued runs they bind wait. */
  #budgetBlocked: BudgetBlock[] = [];
  /** Tells the hub this app apart from another one running under the same machine name. */
  readonly #instance = randomBytes(8).toString("hex");
  #ticking = false;
  #again = false;
  #interval: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #pushTimer: NodeJS.Timeout | undefined;
  #chatTimer: NodeJS.Timeout | undefined;
  /** Writes the web chat's replies (see chat.ts). */
  readonly #chats: ChatWorker;
  /** Writes the Docs writing assistant's asks (see assist.ts). */
  readonly #assists: AssistWorker;
  #assistTimer: NodeJS.Timeout | undefined;
  /** The hub does not know chat.poll yet: heartbeats bring the chat replies instead. */
  #chatPollOff = false;
  #hubState: { ok: boolean | null; checkedAt: string | null; lastOkAt: string | null; code: string | null; error: string | null } = {
    ok: null,
    checkedAt: null,
    lastOkAt: null,
    code: null,
    error: null,
  };
  /** When each run's patch last went to the hub, and in which state (see #patchFor). */
  readonly #patched = new Map<string, { key: string; at: number }>();
  /** What the hub last got of each run (see pushRuns). */
  readonly #pushed = new Map<string, string>();
  #pushing = false;
  /** Run requests from the hub this machine answered but could not tell the hub yet: sent again, never queued twice. */
  readonly #answers = new Map<number, { status: "accepted" | "rejected"; runId: string | null; error: RunRequestError | null }>();
  /** Where a queued best-of-n candidate's branch came from (see remoteStart), for its log. */
  readonly #startNotes = new Map<string, string>();
  /** Requests being answered now: a heartbeat that comes meanwhile leaves them alone. */
  readonly #taking = new Set<number>();
  /** Stop-all (roadmap 27d) as the last heartbeat said; null in local mode and from a hub older than it. */
  #paused: AgentsPaused | null = null;
  /** The agent policy (roadmap 27a) of the last heartbeat that answered; null in local mode and from a hub older than it. */
  #agentPolicy: HubAgentPolicy | null = null;
  /** The tool catalog (roadmap 28b) of the last heartbeat that answered; null in local mode and from a hub older than it. */
  #tools: MachineTools | null = null;

  constructor(host: RunnerHost, opts: RunnerOptions) {
    this.#host = host;
    this.#opts = {
      user: os.userInfo().username,
      now: () => new Date(),
      tickMs: 5000,
      heartbeatMs: 30_000,
      pushMs: 5000,
      chatPollMs: 3000,
      chatProgressMs: 2000,
      assistPollMs: 4000,
      version: "",
      unavailableCooldownMinutes: 10,
      ...opts,
    };
    this.store = new RunStore(path.join(opts.dataDir, "runs.db"));
    this.#chats = new ChatWorker(
      {
        backend: () => this.#host.backend(),
        actor: () => this.#runnerActor(),
        profiles: () => this.#host.profiles(),
        projects: () => this.#host.projects(),
        machine: () => this.#host.machine(),
        env: () => this.#host.env(),
        hubUrl: () => this.#host.hub?.()?.url ?? null,
        ...(this.#host.download ? { download: (url: string, token: string) => this.#host.download!(url, token) } : {}),
        // As the Board would see it: signed out, resting (here or on the hub), or at its plan's stop threshold.
        unavailable: (id) => {
          const p = this.profileStatuses().find((x) => x.id === id);
          const profile = this.#host.profiles().find((x) => x.id === id);
          return !p || p.login?.loggedIn === false || (p.cooldownUntil !== null && p.cooldownUntil > this.#iso()) || (!!profile && usageStop(profile, p.usage) !== null);
        },
      },
      { dataDir: opts.dataDir, progressMs: this.#opts.chatProgressMs },
    );
    this.#assists = new AssistWorker(
      {
        backend: () => this.#host.backend(),
        actor: () => this.#runnerActor(),
        profiles: () => this.#host.profiles(),
        projects: () => this.#host.projects(),
        machine: () => this.#host.machine(),
        env: () => this.#host.env(),
        unavailable: (id) => {
          const p = this.profileStatuses().find((x) => x.id === id);
          const profile = this.#host.profiles().find((x) => x.id === id);
          return !p || p.login?.loggedIn === false || (p.cooldownUntil !== null && p.cooldownUntil > this.#iso()) || (!!profile && usageStop(profile, p.usage) !== null);
        },
      },
      { dataDir: opts.dataDir, progressMs: this.#opts.chatProgressMs },
    );
    mkdirSync(path.join(opts.dataDir, "runs"), { recursive: true });
  }

  start(): void {
    // A group whose running candidate was lost with the app would otherwise wait forever.
    const stalled = new Map(this.store.active().filter((r) => r.status === "running" && r.bestOf).map((r) => [r.bestOf!.group, r.id]));
    this.store.failInterrupted(this.#iso());
    for (const id of stalled.values()) this.#track(this.#bestOfNext(this.store.get(id)!).catch(() => undefined));
    this.#interval = setInterval(() => void this.tick(), this.#opts.tickMs);
    this.#interval.unref();
    // A hub that is down shows up on every other call too; the heartbeat just tries again next time.
    const beat = () => void this.beat();
    this.#heartbeatTimer = setInterval(beat, this.#opts.heartbeatMs);
    this.#heartbeatTimer.unref();
    this.#pushTimer = setInterval(() => void this.pushRuns().catch(() => undefined), this.#opts.pushMs);
    this.#pushTimer.unref();
    if (this.#opts.chatPollMs > 0) {
      this.#chatTimer = setInterval(() => void this.pollChats().catch(() => undefined), this.#opts.chatPollMs);
      this.#chatTimer.unref();
    }
    if (this.#opts.assistPollMs > 0) {
      this.#assistTimer = setInterval(() => void this.pollAssists().catch(() => undefined), this.#opts.assistPollMs);
      this.#assistTimer.unref();
    }
    beat();
    void this.tick();
  }

  /** How the last heartbeat went (hub mode): the interface shows a lost connection from it. */
  hubState(): { ok: boolean | null; checkedAt: string | null; lastOkAt: string | null; code: string | null; error: string | null } {
    return this.#host.mode() === "hub" ? { ...this.#hubState } : { ok: null, checkedAt: null, lastOkAt: null, code: null, error: null };
  }

  /** One heartbeat, recording whether the hub answered. */
  async beat(): Promise<void> {
    if (this.#host.mode() !== "hub") return;
    const at = this.#iso();
    try {
      await this.heartbeat();
      this.#hubState = { ok: true, checkedAt: at, lastOkAt: at, code: null, error: null };
    } catch (err) {
      const { code, message } = toErrorPayload(err);
      this.#hubState = { ...this.#hubState, ok: false, checkedAt: at, code, error: message.slice(0, 300) };
    }
  }

  /** Cancels running agents and waits for their bookkeeping (commit, Hive update) to finish. */
  async stop(): Promise<void> {
    clearInterval(this.#interval);
    clearInterval(this.#heartbeatTimer);
    clearInterval(this.#pushTimer);
    clearInterval(this.#chatTimer);
    clearInterval(this.#assistTimer);
    for (const id of this.#live.keys()) this.cancel(id);
    this.#chats.stop();
    this.#assists.stop();
    await Promise.allSettled([...this.#inflight, this.#chats.settle(), this.#assists.settle(), this.settleSyncs()]);
  }

  /** Resolves once nothing is running and no queued run can start. For tests and graceful quit. */
  async settle(): Promise<void> {
    for (;;) {
      await this.tick();
      if (!this.#inflight.size) return;
      await Promise.allSettled([...this.#inflight]);
    }
  }

  /**
   * `extra.ciFix`: the run fixes a failed MR pipeline (queued by the MR watcher, not by the interface).
   * `extra.requestedBy`: who asked for it on the web (a hub run request).
   */
  async enqueue(req: StartRunRequest, extra: { ciFix?: CiFix; requestedBy?: string } = {}): Promise<AgentRun> {
    const project = this.#host.projects().find((p) => p.name === req.project);
    if (!project) throw new HiveError("not_found", `Dự án ${req.project} chưa được thêm vào app.`, { key: "errors.projectNotAdded", vars: { project: req.project } });
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(req.taskId)) throw new HiveError("bad_request", "Task id không hợp lệ.", { key: "errors.badTaskId" });
    const role = req.role ?? "implement";
    if (!AGENT_ROLES.includes(role)) throw new HiveError("bad_request", `Vai trò không hợp lệ: ${role}`, { key: "errors.badRole", vars: { role } });
    if (req.profileId && !this.#host.profiles().some((p) => p.id === req.profileId)) {
      throw new HiveError("not_found", `Không có profile ${req.profileId}.`, { key: "errors.profileNotFound", vars: { id: req.profileId } });
    }
    const count = req.candidates ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES) {
      throw new HiveError("bad_request", `Số bản phải từ 1 đến ${MAX_CANDIDATES}.`, { key: "errors.badCandidates", vars: { max: MAX_CANDIDATES } });
    }
    if (count > 1 && role !== "implement") throw new HiveError("bad_request", "Chỉ việc Làm mới chạy nhiều bản.", { key: "errors.candidatesImplementOnly" });
    if (count > 1 && req.profileId) throw new HiveError("bad_request", "Nhiều bản cần tự xoay gói sub, không ghim một gói.", { key: "errors.candidatesPinned" });
    const probe = this.#host.profiles().find((p) => p.id === req.profileId) ?? this.#host.profiles()[0];
    const actor: Actor = probe ? this.#actor(probe) : { name: "desktop", role: "agent" };
    const task = (await this.#host.backend().call("tasks.list", { project: req.project }, actor)).find((t) => t.id === req.taskId);
    if (!task) throw new HiveError("not_found", `Không có task ${req.taskId} trong dự án ${req.project}.`, { key: "errors.taskNotInProject", vars: { id: req.taskId, project: req.project } });
    if (task.status === "done") throw new HiveError("bad_request", `Task ${req.taskId} đã xong.`, { key: "errors.taskDone", vars: { id: req.taskId } });
    // An older hub has no dependencies.
    const waiting = task.waitingOn ?? [];
    if (waiting.length) {
      throw new HiveError("conflict", `Task ${req.taskId} đang chờ ${waiting.join(", ")} xong.`, {
        key: "errors.taskWaiting",
        vars: { id: req.taskId, tasks: waiting.join(", ") },
      });
    }
    const active = this.store.activeForTask(req.project, req.taskId);
    if (active) throw new HiveError("conflict", `Task ${req.taskId} đang có run ${active.id} (${active.status}).`, { key: "errors.taskHasRun", vars: { id: req.taskId, run: active.id } });
    const previous = this.store.lastWithWorktree(req.project, req.taskId);
    if (count > 1) return await this.#enqueueCandidates(req, project, task, count, previous, extra.requestedBy ?? null);
    const run = this.store.insert(
      {
        project: req.project,
        taskId: req.taskId,
        taskTitle: task.title,
        role,
        attempt: 1,
        maxAttempts: this.#host.settings().maxAttempts,
        preferredProfile: req.profileId ?? null,
        instructions: (req.instructions ?? "").slice(0, 4000),
        reviewAfter: req.reviewAfter ?? false,
        baseSha: previous?.baseSha ?? null,
        ciFix: extra.ciFix ?? null,
        requestedBy: extra.requestedBy ?? null,
      },
      this.#iso(),
    );
    void this.tick();
    return run;
  }

  /** Candidates start together from the task branch (or HEAD), each on its own branch and worktree. */
  async #enqueueCandidates(req: StartRunRequest, project: DesktopProject, task: Task, count: number, previous: AgentRun | null, requestedBy: string | null): Promise<AgentRun> {
    if (!isGitRepo(project.repo)) throw new HiveError("bad_request", `${project.repo} không phải git repo`, { key: "errors.notGitRepo", vars: { path: project.repo } });
    const branch = branchFor(req.taskId);
    const tip = tryGit(project.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    // No task branch yet: the candidates start from the target branch as the remote has it now.
    const start = tip ? null : await remoteStart(project.repo, project.targetBranch);
    const from = tip ?? git(project.repo, ["rev-parse", start?.ref ?? "HEAD"]);
    const baseSha = tip ? (previous?.baseSha ?? git(project.repo, ["merge-base", "HEAD", branch])) : from;
    const group = `B-${randomBytes(3).toString("hex")}`;
    const now = this.#iso();
    const runs = Array.from({ length: count }, (_, i) =>
      this.store.insert(
        {
          project: req.project,
          taskId: req.taskId,
          taskTitle: task.title,
          role: "implement",
          attempt: 1,
          maxAttempts: this.#host.settings().maxAttempts,
          instructions: (req.instructions ?? "").slice(0, 4000),
          reviewAfter: req.reviewAfter ?? false,
          baseSha,
          bestOf: { group, n: i + 1, of: count, from, pick: null, reason: null },
          requestedBy,
        },
        now,
      ),
    );
    void this.tick();
    return runs[0]!;
  }

  /** Stops a run: one waiting ends now, a running agent is stopped. `note`: why, instead of the Board's own note. */
  /** Holds a CLI's profiles while it is upgraded; letting go starts what waited. */
  holdKind(kind: AgentKind, held: boolean): void {
    if (held) this.#held.add(kind);
    else if (this.#held.delete(kind)) void this.tick();
  }

  /** Runs going on with a CLI of this kind, which an upgrade would pull the files from under. */
  runningOfKind(kind: AgentKind): number {
    const kinds = new Map(this.#host.profiles().map((p) => [p.id, p.kind]));
    return this.store.active().filter((r) => r.status === "running" && r.profileId !== null && kinds.get(r.profileId) === kind).length;
  }

  cancel(id: string, note?: string): AgentRun {
    const run = this.store.get(id);
    if (!run) throw new HiveError("not_found", `Không có run ${id}.`, { key: "errors.runNotFound", vars: { id } });
    if (note) this.#cancelNotes.set(id, note);
    if (run.status === "queued") {
      this.#waiting.delete(id);
      const done = this.store.update(id, { status: "cancelled", finishedAt: this.#iso(), error: note ?? tr("runNote.cancelledQueued") });
      this.#cancelNotes.delete(id);
      // It may have been the last one its group waited for.
      if (done.bestOf) this.#track(this.#bestOfNext(done).catch(() => undefined));
      return done;
    }
    const live = this.#live.get(id);
    if (live) {
      live.cancelled = true;
      stopLive(live);
    } else if (!TERMINAL.includes(run.status)) {
      // Running, but its process is not up yet: the worktree, the context from the hub and the tools come first.
      // There is nothing to kill, so #execute stops just before it starts the agent.
      this.#stopping.add(id);
    }
    return run;
  }

  list(filter: { project?: string; projects?: string[]; limit?: number } = {}): AgentRun[] {
    return this.store.list(filter).map((r) => {
      if (r.status === "queued") return { ...r, error: this.#waiting.get(r.id) ?? r.error };
      if (this.#finishing.has(r.id)) return { ...r, finishing: true };
      const activity = r.status === "running" ? this.#activity.get(r.id) : undefined;
      return activity ? { ...r, activity } : r;
    });
  }

  log(id: string, maxBytes = 200_000): string {
    const file = this.#logPath(id);
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    return (start > 0 ? `${tr("runNote.logClipped")}\n` : "") + buf.toString("utf8");
  }

  /** What the run changed, as a unified diff from its base ("" when nothing, or its worktree and branch are gone). */
  diff(id: string): string {
    const run = this.store.get(id);
    if (!run?.baseSha) return "";
    if (run.worktree && existsSync(run.worktree)) return branchPatch(run.worktree, run.baseSha);
    // A candidate after the choice, or a run whose worktree was removed: its branch stays in the repo.
    const repo = run.branch ? this.#host.projects().find((p) => p.name === run.project)?.repo : undefined;
    return repo && hasBranch(repo, run.branch!) ? branchPatch(repo, run.baseSha, `refs/heads/${run.branch}`) : "";
  }

  /** The patch the hub gets with a run: when the run ended (once), and while it runs at most once a minute. */
  #patchFor(r: AgentRun): string | undefined {
    const done = r.status !== "queued" && r.status !== "running";
    const last = this.#patched.get(r.id);
    const key = `${r.status}:${r.commits}`;
    if (done ? last?.key === key : last && Date.now() - last.at < 60_000) return undefined;
    if (r.status === "queued") return undefined;
    let text: string;
    try {
      text = redactLines(stripHidden(this.diff(r.id)));
    } catch {
      return undefined;
    }
    this.#patched.set(r.id, { key, at: Date.now() });
    return text;
  }

  /** Keeps a candidate by hand, when the judge chose none (or the group stopped without a judge). */
  async pick(id: string): Promise<AgentRun> {
    const run = this.store.get(id);
    if (!run) throw new HiveError("not_found", `Không có run ${id}.`, { key: "errors.runNotFound", vars: { id } });
    const b = run.bestOf;
    if (!b || b.n === 0 || run.status !== "succeeded") throw new HiveError("bad_request", "Chỉ chọn được một bản đã chạy xong.", { key: "errors.notCandidate" });
    if (b.pick !== null) throw new HiveError("conflict", `Đã giữ bản c${b.pick}.`, { key: "errors.alreadyPicked", vars: { n: b.pick } });
    const group = this.store.group(b.group);
    if (group.some((r) => ACTIVE.includes(r.status))) throw new HiveError("conflict", "Nhóm còn run đang chạy hoặc chờ.", { key: "errors.groupActive" });
    // The task went on without the group: keeping a candidate now would drop that work from ai/<task>.
    if (this.store.newerRuns(run.project, run.taskId, group.at(-1)!.createdAt).some((r) => r.bestOf?.group !== b.group)) {
      throw new HiveError("conflict", "Task đã có run mới sau nhóm này.", { key: "errors.taskMovedOn" });
    }
    return this.#keep(run, tr("bestOf.byHand", { user: this.#opts.user }), null);
  }

  removeWorktree(id: string): AgentRun {
    const run = this.store.get(id);
    if (!run?.worktree) throw new HiveError("not_found", "Run không có worktree.", { key: "errors.runNoWorktree" });
    if (this.store.activeForTask(run.project, run.taskId)) throw new HiveError("conflict", "Task đang có run hoạt động.", { key: "errors.taskActiveRun" });
    const project = this.#project(run.project);
    if (existsSync(run.worktree)) removeWorktree(project.repo, run.worktree);
    return run;
  }

  profileStatuses(): AgentProfileStatus[] {
    const now = this.#opts.now();
    const pathEnv = this.#host.env().PATH ?? "";
    return this.#host.profiles().map((profile) => {
      const s = this.store.profileStats(profile.id);
      const cd = this.#cooldownOf(profile);
      const resting = cd && new Date(cd.until) > now ? cd : null;
      return {
        ...profile,
        running: s.running,
        lastUsedAt: s.lastUsedAt,
        stats: s.stats,
        cooldownUntil: resting?.until ?? null,
        cooldownReason: resting?.reason ?? null,
        cooldownFrom: resting?.from ?? null,
        cliPath: resolveBin(expandHome(profile.bin), pathEnv),
        login: this.#host.login?.(profile.id) ?? null,
        usage: this.#host.usage?.(profile.id) ?? null,
        hasToken: Boolean(this.#host.token?.(profile.id)),
        // The policy of the last heartbeat, as tick() and #start apply it: the card shows what a run would get.
        autonomy: profileAutonomy(profile.kind, profile.args, this.#agentPolicy),
      };
    });
  }

  /** Ends the rest on this machine and, for a shared account, on the hub for every machine. */
  async resetCooldown(profileId: string): Promise<void> {
    this.store.clearCooldown(profileId);
    const account = this.#host.profiles().find((p) => p.id === profileId)?.account;
    if (account && this.#host.mode() === "hub") {
      this.#shared.delete(account);
      await this.#host.backend().call("cooldowns.clear", { account }, this.#runnerActor());
    }
    void this.tick();
  }

  /** Reports queued and running runs to the hub and refreshes the shared quota cooldowns. No-op in local mode. */
  async heartbeat(): Promise<HubUpdate | null> {
    if (this.#host.mode() !== "hub") {
      this.#shared.clear();
      this.#paused = null;
      this.#budgetBlocked = [];
      this.#agentPolicy = null;
      this.#tools = null;
      return null;
    }
    const runs = this.store.active().map((r) => ({
      runId: r.id,
      project: r.project,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
      role: r.role,
      status: r.status as "queued" | "running",
      profileId: r.profileId,
      since: r.startedAt ?? r.createdAt,
    }));
    const accounts = new Map(this.#host.profiles().map((p) => [p.id, p.account ?? null]));
    const finished = this.store.unreportedCosts();
    const costs = finished.map((r) => ({
      runId: r.id,
      project: r.project,
      taskId: r.taskId,
      profileId: r.profileId ?? "?",
      account: accounts.get(r.profileId ?? "") ?? null,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens,
      outputTokens: r.outputTokens,
      finishedAt: r.finishedAt!,
      requestedBy: r.requestedBy,
    }));
    const res = await this.#host
      .backend()
      .call(
        "machines.heartbeat",
        {
          machine: this.#host.machine(),
          instance: this.#instance,
          version: this.#opts.version,
          runs,
          costs,
          projects: this.#host.projects().map((p) => p.name),
          acceptsRuns: this.#host.settings().acceptHubRuns,
          ...this.#host.report?.(),
        },
        this.#runnerActor(),
      );
    // Only after the hub answered: a failed heartbeat sends the same costs next time.
    this.store.markCostsReported(finished.map((r) => r.id));
    const next = new Map(res.cooldowns.map((c) => [c.account, c]));
    // Cleared on the hub before it ended (someone pressed "Hết nghỉ"): end the local rest it came from too.
    const now = this.#iso();
    for (const [account, old] of this.#shared) {
      if (next.has(account) || old.until <= now) continue;
      for (const p of this.#host.profiles()) {
        const local = p.account === account ? this.store.cooldown(p.id) : null;
        if (local && local.until <= old.until) this.store.clearCooldown(p.id);
      }
    }
    this.#shared = next;
    const held = this.#budgetBlocked.length;
    // A hub older than 27b sends none: nothing is held.
    this.#budgetBlocked = res.budgetBlocked ?? [];
    // A cap raised, or a new day or month: what it held may start now rather than at the next tick.
    if (held) void this.tick();
    const update: HubUpdate = {
      duplicate: res.duplicate,
      policy: res.policy,
      commands: res.commands,
      syncCommands: res.syncCommands ?? [],
      update: (res as { update?: UpdateOffer | null }).update ?? null,
      agentPolicy: res.agentPolicy ?? null,
      tools: res.tools ?? null,
      profileChanges: res.profileChanges ?? [],
      // The user let project managers drive this machine from the web; without that a merge waits until it expires.
      mergeRuns: this.#host.settings().acceptHubRuns ? (res.mergeRuns ?? []) : [],
    };
    // Before the requests below are taken, so their runs start under the policy the hub just sent.
    this.#agentPolicy = update.agentPolicy ?? null;
    this.#tools = update.tools ?? null;
    this.#opts.onHub?.(update);
    this.#takeSyncs(update.syncCommands);
    // A hub older than runs.dispatch sends none.
    await this.#takeRequests(res.runRequests ?? []);
    if (this.#host.settings().acceptHubRuns) this.#cancelFromHub(res.cancelRuns ?? []);
    if (this.#host.settings().acceptHubRuns) this.#chats.take(res.chatRequests ?? []);
    this.#applyPause(res.paused ?? null);
    return update;
  }

  /**
   * Stop-all from the hub, whether or not this machine takes runs from it: the scope's running runs are stopped, its
   * queued ones (Board runs too) wait in the queue saying why. Applied at every heartbeat, so a run that started
   * between two of them is caught at the next.
   */
  #applyPause(paused: AgentsPaused | null): void {
    const lifted = JSON.stringify(this.#paused) !== JSON.stringify(paused);
    this.#paused = paused;
    for (const run of this.store.active()) {
      const pause = run.status === "running" ? this.#pauseOf(run.project) : null;
      if (!pause || this.#live.get(run.id)?.cancelled) continue;
      this.cancel(run.id, tr("runNote.cancelledPaused", { project: pause.project }));
    }
    // A pause lifted: the queued runs start now rather than at the next tick.
    if (lifted) void this.tick();
  }

  /** The pause that holds a project's runs, if any: the hub's first. */
  #pauseOf(project: string): { project: string; by: string } | null {
    const p = this.#paused;
    if (!p) return null;
    if (p.hub) return { project: tr("runNote.hub"), by: p.by[PAUSED_HUB]?.name ?? "?" };
    return p.projects.includes(project) ? { project, by: p.by[project]?.name ?? "?" } : null;
  }

  /** Starts the sync requests not taken yet, in the background: a heartbeat must not wait for a repo to be written. */
  #takeSyncs(commands: MachineCommand[]): void {
    const sync = this.#opts.sync;
    if (!sync) return;
    for (const cmd of commands) {
      if (cmd.kind !== "sync" || this.#syncsTaken.has(cmd.id)) continue;
      this.#syncsTaken.add(cmd.id);
      const job = this.#runSync(cmd, sync).finally(() => this.#syncs.delete(job));
      this.#syncs.add(job);
    }
  }

  async #runSync(cmd: MachineCommand, sync: (project: DesktopProject) => Promise<SyncReport>): Promise<void> {
    try {
      await this.reportCommand(cmd.id, "running");
    } catch {
      // Not heard: take it again if the hub still sends it (it stops once it expired or was cancelled).
      this.#syncsTaken.delete(cmd.id);
      return;
    }
    // Removed from the app since its last heartbeat: the hub still listed it.
    const project = this.#host.projects().find((p) => p.name === cmd.project);
    let status: "done" | "failed" = "failed";
    let output: string;
    if (!project) {
      output = tr("errors.projectNotAdded", { project: cmd.project ?? "" });
    } else {
      try {
        output = JSON.stringify(syncOutcome(await sync(project)));
        status = "done";
      } catch (err) {
        output = toErrorPayload(err).message;
      }
    }
    // The hub expires a request it never hears the end of; nothing more to do here.
    await this.reportCommand(cmd.id, status, output).catch(() => undefined);
  }

  /** Resolves once the sync requests taken so far have ended. For tests and graceful quit. */
  async settleSyncs(): Promise<void> {
    await Promise.allSettled([...this.#syncs]);
  }

  /** Runs a project manager stopped on the web: asked again at each heartbeat until the hub hears they ended. */
  #cancelFromHub(cancels: RunCancel[]): void {
    for (const { runId, requestedBy } of cancels) {
      const run = this.store.get(runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) continue;
      this.cancel(runId, tr("runNote.cancelledWeb", { who: requestedBy }));
    }
  }

  /**
   * Hub mode, taking runs from the hub: asks for chat replies to write between heartbeats, so the web chat answers
   * within seconds. A hub without chat.poll gets asked no more (its heartbeats carry the replies).
   */
  async pollChats(): Promise<number> {
    if (this.#host.mode() !== "hub" || !this.#host.settings().acceptHubRuns || this.#chatPollOff) return 0;
    try {
      const requests = await this.#host.backend().call("chat.poll", {}, this.#runnerActor());
      this.#chats.take(requests);
      return requests.length;
    } catch (err) {
      if (err instanceof HiveError && err.code === "bad_request" && /unknown method/i.test(err.message)) this.#chatPollOff = true;
      throw err;
    }
  }

  /**
   * Takes an ask of the Docs writing assistant: from the hub while the user lets it take runs, else from this app's own
   * database. True when it took one.
   */
  pollAssists(): Promise<boolean> {
    if (this.#host.mode() === "hub" && !this.#host.settings().acceptHubRuns) return Promise.resolve(false);
    return this.#assists.poll();
  }

  /** Resolves once the ask being written has ended. For tests. */
  settleAssists(): Promise<void> {
    return this.#assists.settle();
  }

  /** Resolves once the chat replies started so far have ended. For tests. */
  settleChats(): Promise<void> {
    return this.#chats.settle();
  }

  /**
   * Queues the runs a project manager asked this machine for on the web, with the checks of the Board's Run agent,
   * while the user allows it (Accept runs from the hub), and tells the hub which it took and why it refused the others.
   */
  async #takeRequests(requests: RunRequest[]): Promise<void> {
    for (const req of requests) {
      if (this.#taking.has(req.id)) continue;
      this.#taking.add(req.id);
      try {
        let answer = this.#answers.get(req.id);
        if (!answer) {
          answer = await this.#take(req);
          this.#answers.set(req.id, answer);
        }
        await this.#host.backend().call("runs.requestResult", { id: req.id, ...answer }, this.#runnerActor());
        this.#answers.delete(req.id);
      } catch (err) {
        // Cancelled or expired meanwhile: nothing left to tell. Otherwise the next heartbeat tries again.
        if (err instanceof HiveError && (err.code === "conflict" || err.code === "not_found")) this.#answers.delete(req.id);
      } finally {
        this.#taking.delete(req.id);
      }
    }
  }

  async #take(req: RunRequest): Promise<{ status: "accepted" | "rejected"; runId: string | null; error: RunRequestError | null }> {
    if (!this.#host.settings().acceptHubRuns) {
      const machine = this.#host.machine();
      return { status: "rejected", runId: null, error: { message: `${machine} does not take runs from the hub.`, key: "errors.machineNoHubRuns", vars: { machine } } };
    }
    try {
      const run = await this.enqueue(
        {
          project: req.project,
          taskId: req.taskId,
          role: req.role,
          profileId: req.profileId,
          reviewAfter: req.reviewAfter,
          candidates: req.candidates,
          instructions: req.instructions,
        },
        { requestedBy: req.requestedBy },
      );
      this.#opts.onEvent?.({ type: "dispatched", run, by: req.requestedBy });
      return { status: "accepted", runId: run.id, error: null };
    } catch (err) {
      const { message, key, vars } = toErrorPayload(err);
      const short = (v: string | number) => (typeof v === "string" ? v.slice(0, 300) : v);
      return {
        status: "rejected",
        runId: null,
        error: {
          message: message.slice(0, 2000),
          ...(key && key.length <= 80 ? { key } : {}),
          ...(vars ? { vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.slice(0, 40), short(v)])) } : {}),
        },
      };
    }
  }

  /**
   * Hub mode: sends the runs that changed since the last push (the active ones and those that ended in the last day),
   * each with its current step and the end of its readable log, lines that look like secrets hidden. The web shows
   * them. Returns how many went; a hub that does not know runs.push yet just gets nothing.
   */
  async pushRuns(): Promise<number> {
    if (this.#host.mode() !== "hub" || this.#pushing) return 0;
    this.#pushing = true;
    try {
      const since = this.#iso(-24 * 60);
      const recent = this.list({ limit: 60 }).filter((r) => r.status === "queued" || r.status === "running" || (r.finishedAt ?? "") >= since);
      // An MR the watcher looked at today, however old its run: the web shows its state and checks next to Merge (18c).
      const seen = new Set(recent.map((r) => r.id));
      for (const r of this.store.openMrs(this.#iso(-30 * 24 * 60))) if (!seen.has(r.id) && (r.mrCheckedAt ?? "") >= since) recent.push(r);
      const changed: Array<{ run: AgentRun; key: string; log: string; patch?: string }> = [];
      let patches = 0;
      for (const r of recent) {
        const log = this.#logTail(r.id);
        // A few patches per push keep the request small; the others go with the next ones.
        const patch = patches < 3 ? this.#patchFor(r) : undefined;
        if (patch !== undefined) patches++;
        const key = JSON.stringify([r.status, r.activity ?? null, r.finishing ?? false, r.mrUrl, r.commits, log.length, log.slice(-200), mrOf(r)]);
        if (this.#pushed.get(r.id) !== key || patch !== undefined) changed.push({ run: r, key, log, ...(patch !== undefined ? { patch } : {}) });
        if (changed.length === 20) break;
      }
      if (!changed.length) return 0;
      const clip = (s: string | null, n: number) => (s === null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);
      await this.#host.backend().call(
        "runs.push",
        {
          machine: this.#host.machine(),
          runs: changed.map(({ run: r, log, patch }) => ({
            runId: r.id,
            project: r.project,
            taskId: r.taskId,
            taskTitle: r.taskTitle,
            role: r.role,
            status: r.status,
            profileId: r.profileId,
            activity: clip(r.activity ?? null, 300),
            summary: clip(r.summary, 4000),
            // A queued run's note is why it waits.
            error: clip(r.error, 2000),
            branch: r.branch,
            commits: r.commits,
            mrUrl: r.mrUrl,
            mr: mrOf(r),
            costUsd: r.costUsd,
            log,
            ...(patch !== undefined ? { patch } : {}),
            createdAt: r.createdAt,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
          })),
        },
        this.#runnerActor(),
      );
      for (const c of changed) this.#pushed.set(c.run.id, c.key);
      return changed.length;
    } finally {
      this.#pushing = false;
    }
  }

  /** The last lines of a run's log for the hub: no colour codes or hidden characters, secret-looking lines replaced. */
  #logTail(id: string, lines = 200, bytes = 48_000): string {
    const text = this.log(id, bytes)
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .split("\n");
    return redactLines(stripHidden(text.slice(-lines).join("\n"))).slice(-58_000);
  }

  /** Reports progress on an admin's install request back to the hub, under this machine's heartbeat name. */
  reportCommand(id: number, status: Exclude<CommandStatus, "pending" | "cancelled" | "expired">, output?: string): Promise<MachineCommand> {
    return this.#host
      .backend()
      .call("machines.commandResult", { id, status: status as "running" | "done" | "failed" | "rejected", output: output?.slice(-8000) }, this.#runnerActor());
  }

  async tick(): Promise<void> {
    if (this.#ticking) {
      this.#again = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#again = false;
        const now = this.#opts.now();
        for (const run of this.store.queued()) {
          const pause = this.#pauseOf(run.project);
          if (pause) {
            this.#waiting.set(run.id, tr("runNote.waitingPaused", pause));
            continue;
          }
          const capped = this.#budgetHold(run);
          if (capped) {
            this.#waiting.set(run.id, capped);
            continue;
          }
          if (this.store.running() >= this.#host.settings().maxParallel) {
            this.#waiting.set(run.id, tr("runNote.waitingParallel"));
            continue;
          }
          const all = this.#loads();
          const needs = this.#needs(run);
          // A profile the agent policy rules out is skipped like one out of quota.
          const blocked = this.#policyBlocked(this.#policyOf(run.project));
          const loads = all.filter((l) => !blocked.has(l.profile.id));
          const pick = pickProfile(loads, needs, now);
          if (!pick) {
            const could = all.filter(
              (l) =>
                l.profile.enabled &&
                (needs.preferredProfile ? l.profile.id === needs.preferredProfile : l.profile.roles.includes(needs.role)) &&
                !needs.excludedProfiles.includes(l.profile.id),
            );
            // Waiting would not help: every profile that could take the run is ruled out until the policy changes.
            if (could.length && could.every((l) => blocked.has(l.profile.id))) {
              this.#failByPolicy(run, could.map((l) => `${l.profile.id}: ${blocked.get(l.profile.id)}`));
              continue;
            }
            this.#waiting.set(run.id, waitingReason(loads, needs, now));
            continue;
          }
          this.#waiting.delete(run.id);
          this.#launch(run, pick.profile);
        }
      } while (this.#again);
    } finally {
      this.#ticking = false;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Why a queued run waits for a spending cap, if one binds it: the hub's, its project's, or its requester's. A run
   * started here has no requester; it counts for the account of this machine's token, which the hub marks `self`.
   */
  #budgetHold(run: AgentRun): string | null {
    const block = this.#budgetBlocked.find(
      (b) => b.hub || b.project === run.project || (b.user !== undefined && (run.requestedBy ? b.user === run.requestedBy : b.self === true)),
    );
    return block ? tr("runNote.waitingBudget", block.vars) : null;
  }

  #iso(offsetMinutes = 0): string {
    return new Date(this.#opts.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  /** What a run of the project may do (roadmap 27a): the hub's policy merged with the project's; open in local mode. */
  #policyOf(project: string): AgentPolicy {
    const p = this.#agentPolicy;
    return p ? effectivePolicy(p.hub, p.projects[project] ?? null) : OPEN_POLICY;
  }

  /** The profiles the policy rules out, with why. */
  #policyBlocked(pol: AgentPolicy): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of this.#host.profiles()) {
      const reason = policyBlocks(p, pol);
      if (reason) out.set(p.id, reason);
    }
    return out;
  }

  /** A queued run no profile may take under the policy: failed now, with each profile's reason in its log. */
  #failByPolicy(run: AgentRun, reasons: string[]): void {
    const error = tr("errors.policyNoProfile", { reasons: reasons.join("; ") });
    try {
      appendFileSync(this.#logPath(run.id), `# ${error}\n`);
    } catch {
      // The run's error says the same.
    }
    this.#waiting.delete(run.id);
    const done = this.store.update(run.id, { status: "failed", finishedAt: this.#iso(), error });
    this.#opts.onEvent?.({ type: "finished", run: done });
    // It may have been the last one its group waited for.
    if (done.bestOf) this.#track(this.#bestOfNext(done).catch(() => undefined));
  }

  /** The MCP servers Codex's config.toml has (the profile's CODEX_HOME, else ~/.codex), to turn off those the policy leaves out. */
  #codexServers(profile: AgentProfile): string[] {
    const home = profile.env.CODEX_HOME ? expandHome(profile.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
    try {
      return codexMcpNames(readFileSync(path.join(home, "config.toml"), "utf8"));
    } catch {
      return [];
    }
  }

  #logPath(id: string): string {
    return path.join(this.#opts.dataDir, "runs", `${id}.log`);
  }

  #project(name: string): DesktopProject {
    const p = this.#host.projects().find((x) => x.name === name);
    if (!p) throw new HiveError("not_found", `Dự án ${name} chưa được thêm vào app.`, { key: "errors.projectNotAdded", vars: { project: name } });
    return p;
  }

  #actor(profile: AgentProfile): Actor {
    // Same naming as the hive-mcp shim, so the agent's own task_claim/task_update match the runner's lease.
    return { name: agentActorName(profile.id, this.#host.mode(), this.#host.machine(), this.#opts.user), role: "agent" };
  }

  #runnerActor(): Actor {
    return { name: agentActorName("runner", this.#host.mode(), this.#host.machine(), this.#opts.user), role: "agent" };
  }

  /** The later of this machine's cooldown and the hub's one for the profile's account (`from` = who reported it). */
  #cooldownOf(profile: AgentProfile): { until: string; reason: string; from: string | null } | null {
    const local = this.store.cooldown(profile.id);
    const shared = profile.account && this.#host.mode() === "hub" ? this.#shared.get(profile.account) : undefined;
    if (shared && (!local || shared.until > local.until)) return { until: shared.until, reason: shared.reason, from: shared.reportedBy };
    return local ? { ...local, from: null } : null;
  }

  /** Tells the hub the profile's account is resting, so other machines skip it. Returns an error note, if any. */
  async #shareCooldown(profile: AgentProfile, until: string, reason: string): Promise<string | null> {
    if (!profile.account || this.#host.mode() !== "hub") return null;
    try {
      const c = await this.#host
        .backend()
        .call("cooldowns.set", { account: profile.account, until, reason: reason.slice(0, 300) }, this.#runnerActor());
      if (c) this.#shared.set(c.account, c);
      return null;
    } catch (err) {
      return tr("runNote.quotaNotShared", { reason: (err as Error).message });
    }
  }

  #loads(): ProfileLoad[] {
    const pathEnv = this.#host.env().PATH ?? "";
    return this.#host.profiles().map((profile) => {
      const s = this.store.profileStats(profile.id);
      return {
        profile,
        running: s.running,
        lastUsedAt: s.lastUsedAt,
        cooldownUntil: this.#cooldownOf(profile)?.until ?? null,
        installed: !this.#held.has(profile.kind) && resolveBin(expandHome(profile.bin), pathEnv) !== null,
        loggedIn: this.#host.login?.(profile.id)?.loggedIn !== false,
        overLimit: usageStop(profile, this.#host.usage?.(profile.id)) !== null,
        headroom: usageHeadroom(profile, this.#host.usage?.(profile.id)),
      };
    });
  }

  #needs(run: AgentRun): RunNeeds {
    const needs: RunNeeds = {
      role: run.role,
      preferredProfile: run.preferredProfile,
      avoidKinds: run.avoidKinds,
      excludedProfiles: run.excludedProfiles,
      // A review is only a cross-review on another vendor: it waits for one that is busy.
      strictKinds: run.role === "review",
    };
    const b = run.bestOf;
    if (!b || b.n === 0) return needs;
    // Each candidate on its own subscription, and vendor, while there are enough; one of theirs again otherwise.
    const others = new Set(this.store.group(b.group).flatMap((r) => (r.bestOf!.n > 0 && r.bestOf!.n !== b.n && r.profileId ? [r.profileId] : [])));
    const kinds = this.#host.profiles().flatMap((p) => (others.has(p.id) ? [p.kind] : []));
    return { ...needs, avoidProfiles: [...others], avoidKinds: [...new Set([...run.avoidKinds, ...kinds])] };
  }

  /** What the judge compares: the candidates that finished. */
  #judgeInput(b: BestOf): { from: string; candidates: JudgeCandidate[] } {
    const done = latestCandidates(this.store.group(b.group)).filter((c) => c.status === "succeeded");
    return {
      from: b.from,
      candidates: done.map((c) => ({
        n: c.bestOf!.n,
        profileId: c.profileId,
        branch: c.branch ?? branchFor(candidateName(c.taskId, c.bestOf!.n)),
        commits: c.commits,
        summary: c.summary,
      })),
    };
  }

  async #task(backend: HiveBackend, actor: Actor, run: AgentRun): Promise<Task> {
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    if (!task) throw new HiveError("not_found", `Không có task ${run.taskId} trong dự án ${run.project}.`, { key: "errors.taskNotInProject", vars: { id: run.taskId, project: run.project } });
    return task;
  }

  /**
   * Puts the project's Hive context in the worktree before the agent starts (roadmap 38a), so every role reads the
   * current AGENTS.md, rules and skills even when the target branch has none of them. The files are the app's, not
   * the branch's: `wt.context` keeps them out of the run's commit. A hub that fails or is slow is not worth losing
   * a run over, so then the run goes on with what the branch has and the log says why.
   */
  async #writeContext(backend: HiveBackend, actor: Actor, project: string, wt: Worktree): Promise<{ note: string; file: string | null }> {
    try {
      const out = await renderContext(backend, actor, project, wt.path);
      wt.context = out.owned;
      return {
        note: tr("runNote.context", { files: out.owned.length, written: out.written.length, skipped: out.skipped.length }),
        file: out.contextFile,
      };
    } catch (err) {
      return { note: tr("runNote.contextFailed", { reason: (err as Error).message }), file: null };
    }
  }

  /** Marks the run running synchronously (so the next tick sees the slot taken), then does the slow work. */
  #launch(queued: AgentRun, profile: AgentProfile): void {
    const run = this.store.update(queued.id, { status: "running", profileId: profile.id, startedAt: this.#iso(), error: null });
    const job = this.#execute(run, profile).catch(() => undefined);
    this.#track(job);
  }

  #track(job: Promise<void>): void {
    this.#inflight.add(job);
    void job.finally(() => this.#inflight.delete(job));
  }

  async #execute(run: AgentRun, chosen: AgentProfile): Promise<void> {
    // Fitted before the first await, under the same policy tick() checked the profile against.
    const pol = this.#policyOf(run.project);
    const fit = applyPolicy(chosen, pol, chosen.kind === "codex" && pol.mcp !== null ? this.#codexServers(chosen) : []);
    const profile = fit.profile;
    const skipped = [...this.#policyBlocked(pol)].map(([id, reason]) => `# policy skipped ${id}: ${reason}\n`).join("");
    let wt: Worktree | null = null;
    let mcpFile: string | null = null;
    let egress: { plan: Egress; docker: string; env: NodeJS.ProcessEnv } | null = null;
    let log: WriteStream | null = null;
    try {
      const project = this.#project(run.project);
      const root = this.#host.settings().worktreeRoot ?? path.join(this.#opts.dataDir, "worktrees");
      // A candidate has its own; the judge reads the candidates' branches from the task's.
      const candidate = run.bestOf && run.bestOf.n > 0 ? run.bestOf : null;
      const name = candidate ? candidateName(run.taskId, candidate.n) : run.taskId;
      // A task without its branch yet starts from the target branch as the remote has it now; an existing branch
      // (a follow-up, a review, the kept candidate) goes on from its own history.
      const fresh = !candidate && !hasBranch(project.repo, branchFor(run.taskId)) ? await remoteStart(project.repo, project.targetBranch) : null;
      const startNote = fresh?.note ?? this.#startNotes.get(run.id) ?? null;
      this.#startNotes.delete(run.id);
      wt = ensureWorktree(
        project.repo,
        path.join(root, project.name, name),
        run.taskId,
        run.baseSha,
        candidate ? { branch: branchFor(name), from: candidate.from } : { start: fresh?.ref ?? undefined },
      );
      const backend = this.#host.backend();
      const actor = this.#actor(profile);
      const task = await this.#task(backend, actor, run);
      run = this.store.update(run.id, { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, taskTitle: task.title });
      // The branch may carry no Hive context at all (a repo whose context MR is not merged), and the prompt tells
      // every role to read AGENTS.md: put the current one in the worktree, outside the branch.
      const context = await this.#writeContext(backend, actor, run.project, wt);

      const parent = run.parentRunId ? this.store.get(run.parentRunId) : null;
      const prompt = buildPrompt({
        project: run.project,
        taskId: run.taskId,
        title: task.title,
        note: task.note,
        role: run.role,
        instructions: run.instructions,
        worktree: wt.path,
        branch: wt.branch,
        baseSha: wt.baseSha,
        attempt: run.attempt,
        previous: parent?.role === run.role && parent.profileId ? { profileId: parent.profileId, reason: parent.error ?? parent.status } : null,
        readOnly: profile.readOnly,
        ciFix: run.ciFix,
        candidate: candidate ? { n: candidate.n, of: candidate.of } : null,
        judge: run.bestOf?.n === 0 ? this.#judgeInput(run.bestOf) : null,
        contextFile: context.file,
      });
      const vars = { prompt, worktree: wt.path, task: run.taskId, project: run.project, branch: wt.branch, run: run.id, repo: project.repo };
      // A container has neither the hive-mcp shim nor this machine's codegraph: Claude gets the hub's MCP through a file.
      if (profile.container) {
        mcpFile = path.join(this.#opts.dataDir, "runs", `${run.id}.mcp.json`);
        writeFileSync(mcpFile, JSON.stringify({ mcpServers: this.#containerMcp(profile, run) }), { mode: 0o600 });
      }
      const base = this.#host.env();
      const features = profile.container ? NO_FEATURES : repoFeatures(project.repo);
      // The variables the run has (the machine's, then the profile's), for a tool's secrets: named, never logged.
      const runEnv: Record<string, string | undefined> = { ...base, ...expandEnv(profile.env) };
      const tools: ToolPick = profile.container
        ? NO_TOOLS
        : this.#tools
          ? runTools(this.#tools, run.project, features, profile.kind, pol, this.#host.toolTrust?.() ?? {}, runEnv)
          : legacyPick(features, profile.kind, fit.mcp);
      wt.toolDirs = toolDirs(tools.prepare);
      const cmd = buildCommand(profile, vars, this.#tools && !profile.container ? tools.tools : features, mcpFile ?? undefined, fit.mcp);
      const bin = resolveBin(profile.container ? "docker" : cmd.bin, base.PATH ?? "");
      if (!bin) {
        const reason = profile.container ? tr("runNote.dockerNotFound") : tr("runNote.binNotFound", { bin: cmd.bin });
        await this.#complete(run, profile, wt, { kind: "unavailable", reason });
        return;
      }

      if (run.role !== "review") {
        // Candidates share one lease, which the runner holds for the group (long enough for the slowest profile).
        const minutes = candidate ? Math.max(...this.#host.profiles().map((p) => p.timeoutMinutes)) : profile.timeoutMinutes;
        const lease = Math.min(minutes + 15, 24 * 60);
        const claim = await backend.call("tasks.claim", { id: run.taskId, leaseMinutes: lease }, candidate ? this.#runnerActor() : actor);
        if (!claim.claimed) {
          const owner = claim.task?.owner ?? "?";
          const until = claim.task?.leaseUntil ?? "?";
          throw new HiveError("conflict", tr("runNote.taskHeld", { owner, until }), { key: "runNote.taskHeld", vars: { owner, until } });
        }
        if (claim.task?.owner) this.#owners.set(candidate?.group ?? run.id, claim.task.owner);
      }

      log = createWriteStream(this.#logPath(run.id), { flags: "a" });
      log.on("error", () => undefined); // a failing log file must not take the app down
      const hostEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_")));
      // One after the other, before the agent: built for Claude, whose servers the runner lists, and for another CLI
      // whose own config starts the same server.
      const prepared: string[] = [];
      for (const e of tools.prepare) {
        const secrets: Record<string, string> = {};
        for (const n of e.secretEnv) {
          const value = runEnv[n];
          if (value) secrets[n] = value;
        }
        prepared.push(await prepareTool(e, wt.path, { repo: project.repo }, (bin) => resolveBin(bin, base.PATH ?? ""), { ...hostEnv, ...secrets }));
      }
      const toolLines = [...tools.notes.map((n) => `# ${n}`), ...prepared].map((l) => `${l}\n`).join("");
      const agentEnv: Record<string, string> = {
        ...expandEnv(profile.env),
        HIVE_AGENT: profile.id,
        HIVE_PROJECT: run.project,
        HIVE_TASK: run.taskId,
        HIVE_RUN: run.id,
        ...(profile.readOnly ? { HIVE_READONLY: "1" } : {}),
        ...cmd.env,
      };
      // A restricted container: its own network and proxy, set up before the agent starts.
      if (profile.container && profile.container.network !== "open") {
        const allow = egressAllow(profile, { hub: this.#host.hub?.()?.url, gitlab: this.#host.gitlab?.() });
        egress = { plan: egressPlan(run.id, profile.container.image, allow), docker: bin, env: { ...hostEnv, HIVE_EGRESS_ALLOW: allow.join(",") } };
        try {
          for (const step of egress.plan.setup) await dockerRun(egress.docker, step, egress.env);
        } catch (err) {
          throw new HiveError("bad_request", tr("runNote.egressFailed", { reason: (err as Error).message }), {
            key: "runNote.egressFailed",
            vars: { reason: (err as Error).message },
          });
        }
      }
      // In a container the agent gets only its own variables; docker itself keeps the machine's (PATH, DOCKER_HOST).
      const hub = this.#containerHub();
      const token = profile.kind === "claude" ? this.#host.token?.(profile.id) : undefined;
      const box = profile.container
        ? containerCommand({
            profile,
            // Codex takes the hub's MCP as config overrides before its subcommand.
            args: profile.kind === "codex" ? [...codexMcpArgs(hub, this.#mcpRun(profile, run)), ...cmd.args] : cmd.args,
            stdin: cmd.stdin,
            runId: run.id,
            worktree: wt.path,
            gitDir: git(wt.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            env: {
              ...agentEnv,
              ...hubMcpEnv(hub, this.#mcpRun(profile, run), profile.kind),
              // The macOS Keychain stays outside: a saved long-lived token signs Claude Code in.
              ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
            },
            readOnly: mcpFile ? [mcpFile] : [],
            ...(egress ? { network: { args: egress.plan.runArgs, env: egress.plan.env } } : {}),
          })
        : null;
      log.write(
        `$ ${describeCommand(cmd)}\n${box ? `# container ${box.name} · image ${profile.container!.image} · ${egress ? `network limited (${egress.env.HIVE_EGRESS_ALLOW})` : "network open"}\n` : ""}${startNote ? `# ${startNote}\n` : ""}# hive context: ${context.note}\n${toolLines}# cwd ${wt.path}\n# profile ${profile.id} · attempt ${run.attempt}/${run.maxAttempts} · role ${run.role}\n${policyLine(pol, fit)}\n${skipped}\n## Prompt\n${prompt}\n\n## Output\n`,
      );

      // Cancelled while this run was being set up: stop here rather than start an agent nobody waits for.
      if (this.#stopping.delete(run.id)) {
        log.write(`\n# ${tr("runNote.cancelled")}\n`);
        await new Promise<void>((r) => log!.end(r));
        log = null;
        await this.#complete(run, profile, wt, { kind: "exit", code: null, stdout: "", all: "", cancelled: true, timedOut: false });
        return;
      }
      const env: NodeJS.ProcessEnv = box ? { ...hostEnv, ...box.env } : { ...hostEnv, ...agentEnv };
      const child = spawn(bin, box ? box.args : cmd.args, {
        cwd: wt.path,
        env,
        detached: process.platform !== "win32",
        stdio: [cmd.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const live: Live = { child, cancelled: false, timedOut: false, ...(box ? { container: { docker: bin, name: box.name, env } } : {}) };
      this.#live.set(run.id, live);
      const timer = setTimeout(() => {
        live.timedOut = true;
        stopLive(live);
      }, profile.timeoutMinutes * 60_000);
      if (cmd.stdin !== null) child.stdin?.end(cmd.stdin);

      let stdout = "";
      let all = "";
      const out = log;
      // What the agent writes carries the time of each line; the header above and the result below do not.
      const stamp = lineStamper(this.#opts.now);
      // Claude Code's events become a log to follow while it runs; other CLIs write text as they go, and
      // their last line is what they are doing now.
      const stream = cmd.claudeStream ? new ClaudeStream(wt.path) : cmd.codexJson ? new CodexStream(wt.path) : null;
      const decode = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
      const lastLine = (text: string) => {
        const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
        if (line) this.#activity.set(run.id, line.length > 160 ? `${line.slice(0, 159)}…` : line);
      };
      child.stdout?.on("data", (b: Buffer) => {
        const text = decode.out.write(b);
        if (stream) {
          out.write(stamp(stream.push(text)));
          if (stream.state.activity) this.#activity.set(run.id, stream.state.activity);
        } else {
          out.write(stamp(text));
          lastLine(text);
        }
        stdout = keepTail(stdout + text, cmd.claudeJson || stream ? JSON_BYTES : TAIL_BYTES);
        all = keepTail(all + text);
      });
      child.stderr?.on("data", (b: Buffer) => {
        const text = decode.err.write(b);
        out.write(stamp(text));
        if (!stream) lastLine(text);
        all = keepTail(all + text);
      });

      const outcome = await new Promise<Outcome>((resolve) => {
        child.once("error", (err) => resolve({ kind: "error", reason: tr("runNote.spawnFailed", { bin: cmd.bin, reason: err.message }) }));
        child.once("close", (code) =>
          resolve({ kind: "exit", code, stdout, all, cancelled: live.cancelled, timedOut: live.timedOut }),
        );
      });
      clearTimeout(timer);
      this.#live.delete(run.id);
      this.#activity.delete(run.id);
      if (stream) out.write(stamp(stream.end()));
      if (outcome.kind === "exit" && (cmd.claudeJson || stream)) {
        outcome.usage =
          stream instanceof CodexStream
            ? stream.tokens.turns
              ? {
                  text: stream.lastText,
                  costUsd: null,
                  // OpenAI counts cached input inside input_tokens: taken out, to mean what Claude's does.
                  inputTokens: Math.max(0, stream.tokens.input - stream.tokens.cached),
                  cacheWriteTokens: 0,
                  cacheReadTokens: stream.tokens.cached,
                  outputTokens: stream.tokens.output,
                }
              : null
            : parseClaudeResult((stream instanceof ClaudeStream ? stream.result : null) ?? outcome.stdout);
        // No result (killed, crashed): the summary is its last message, not the raw events.
        // A Codex that printed no events (one older than --json) keeps what it wrote.
        if (stream && !outcome.usage) outcome.stdout = stream.lastText ?? (stream instanceof CodexStream ? outcome.stdout : "");
        const u = outcome.usage;
        if (u?.text) out.write(`\n\n## Result\n${u.text}\n`);
        if (u && (u.costUsd !== null || u.outputTokens !== null)) {
          const share = cacheReadShare(u);
          out.write(
            `# cost ${u.costUsd === null ? "?" : `$${u.costUsd.toFixed(4)}`} · tokens in ${u.inputTokens ?? "?"} cache write ${u.cacheWriteTokens ?? "?"} cache read ${u.cacheReadTokens ?? "?"}` +
              ` out ${u.outputTokens ?? "?"}${share === null ? "" : ` · ${Math.round(share * 100)}% from cache`}\n`,
          );
        }
      }
      if (egress) {
        // What the proxy refused: the run's log says so, and a failed run names the hosts.
        const denied = deniedHosts(await dockerRun(egress.docker, ["logs", egress.plan.proxy], egress.env).catch(() => ""));
        if (denied.length) {
          out.write(`\n## Network\n${denied.map((d) => `denied ${d.host} ×${d.count}`).join("\n")}\n`);
          if (outcome.kind === "exit") outcome.blocked = denied.map((d) => d.host);
        }
      }
      out.write(`\n# exit ${outcome.kind === "exit" ? outcome.code : outcome.kind}\n`);
      await new Promise<void>((r) => out.end(r));
      log = null;
      await this.#complete(run, profile, wt, outcome);
    } catch (err) {
      log?.end();
      await this.#complete(run, profile, wt, { kind: "error", reason: (err as Error).message ?? String(err) });
    } finally {
      this.#stopping.delete(run.id);
      // It carries the hub token: gone with the run.
      if (mcpFile) rmSync(mcpFile, { force: true });
      // A step can fail when setup stopped half-way: try them all.
      if (egress) for (const step of egress.plan.teardown) await dockerRun(egress.docker, step, egress.env).catch(() => undefined);
    }
  }

  /** Where an agent in a container reaches Hive: the hub (hub mode only; see container-mcp.ts). */
  #containerHub(): { url: string; token: string } | null {
    const hub = this.#host.mode() === "hub" ? this.#host.hub?.() : null;
    return hub?.url && hub.token ? hub : null;
  }

  #mcpRun(profile: AgentProfile, run: AgentRun): McpRun {
    return {
      agent: agentActorName(profile.id, "hub", this.#host.machine(), this.#opts.user),
      machine: this.#host.machine(),
      project: run.project,
      task: run.taskId,
      run: run.id,
      readOnly: profile.readOnly,
    };
  }

  /** Claude Code's MCP servers for a container run (the file the runner writes). */
  #containerMcp(profile: AgentProfile, run: AgentRun): Record<string, unknown> {
    return claudeMcpServers(this.#containerHub(), this.#mcpRun(profile, run));
  }

  /** The run's status is saved first; the MR and the Hive note come after, so list() says it is still finishing. */
  async #complete(run: AgentRun, profile: AgentProfile, wt: Worktree | null, outcome: Outcome): Promise<void> {
    this.#finishing.add(run.id);
    try {
      await this.#finish(run, profile, wt, outcome);
    } finally {
      this.#finishing.delete(run.id);
      // The web sees the end (summary, commits, MR) now rather than at the next push.
      this.#track(
        this.pushRuns()
          .then(() => this.#opts.afterReport?.(run))
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    }
  }

  async #finish(run: AgentRun, profile: AgentProfile, wt: Worktree | null, outcome: Outcome): Promise<void> {
    const now = this.#opts.now();
    let status: RunStatus = "failed";
    let error: string | null = null;
    let rotate = false;
    let exitCode: number | null = null;
    let summary: string | null = null;
    let usage: Partial<Pick<AgentRun, "costUsd" | "inputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens">> = {};

    if (outcome.kind === "unavailable") {
      error = outcome.reason;
      rotate = true;
      this.store.setCooldown(profile.id, this.#iso(this.#opts.unavailableCooldownMinutes), outcome.reason);
    } else if (outcome.kind === "error") {
      error = outcome.reason;
    } else {
      exitCode = outcome.code;
      const text = (outcome.usage?.text ?? outcome.stdout).trim();
      summary = text ? clip(text, 1500) : null;
      if (outcome.usage) {
        const u = outcome.usage;
        usage = { costUsd: u.costUsd, inputTokens: u.inputTokens, cacheWriteTokens: u.cacheWriteTokens, cacheReadTokens: u.cacheReadTokens, outputTokens: u.outputTokens };
      }
      const hit = outcome.code !== 0 && !outcome.cancelled ? detectRateLimit(outcome.all, now) : null;
      if (outcome.cancelled) {
        status = "cancelled";
        error = this.#cancelNotes.get(run.id) ?? tr("runNote.cancelled");
        this.#cancelNotes.delete(run.id);
      } else if (outcome.timedOut) {
        error = tr("runNote.timedOut", { minutes: profile.timeoutMinutes });
      } else if (outcome.code === 0) {
        status = "succeeded";
      } else if (hit) {
        status = "rate_limited";
        rotate = true;
        error = hit.reason;
        const until = hit.resetAt && hit.resetAt > now ? hit.resetAt.toISOString() : this.#iso(profile.cooldownMinutes);
        this.store.setCooldown(profile.id, until, hit.reason);
        const shareError = await this.#shareCooldown(profile, until, hit.reason);
        if (shareError) error = `${error} · ${shareError}`;
      } else {
        const lastErr = (outcome.usage?.text ?? outcome.all).trim().split("\n").at(-1) ?? "";
        error = `${tr("runNote.exited", { code: outcome.code ?? "?" })}${lastErr ? `: ${clip(lastErr, 200)}` : ""}`;
      }
      if (status !== "succeeded" && outcome.blocked?.length) {
        error = [error, tr("runNote.networkBlocked", { hosts: outcome.blocked.slice(0, 5).join(", ") })].filter(Boolean).join(" · ");
      }
    }

    let commits = run.commits;
    let headSha = run.headSha;
    // The judge changes nothing: what it left is dropped when the kept candidate replaces the branch.
    if (wt && existsSync(wt.path) && run.bestOf?.n !== 0) {
      const label = run.role === "review" ? "review" : status === "succeeded" ? "work" : "wip";
      const c = commitAll(wt.path, `ai(${run.taskId}): ${label} by ${profile.id}\n\nRun ${run.id}, attempt ${run.attempt}, status ${status}`, [...wt.copied, ...(wt.context ?? [])], wt.toolDirs);
      if (c.error) {
        error = [error, `commit: ${c.error}`].filter(Boolean).join(" · ");
        // Its work is in the worktree, not on the branch: an MR or review would show nothing, so it did not succeed.
        if (status === "succeeded") status = "failed";
      }
      ({ commits, headSha } = branchState(wt.path, wt.baseSha));
    }

    const done = this.store.update(run.id, { status, error, exitCode, summary, commits, headSha, ...usage, finishedAt: now.toISOString() });
    await this.#report(done, profile).catch((err: unknown) => {
      this.store.update(run.id, { error: [done.error, `Hive: ${(err as Error).message}`].filter(Boolean).join(" · ") });
    });

    // A candidate's branch is not the task's yet: its MR waits for the choice (#keep).
    if (this.#opts.afterFinish && !run.bestOf) {
      const extra = await this.#opts.afterFinish(this.store.get(run.id)!).catch((err: unknown) => ({
        mrState: "failed" as const,
        mrNote: (err as Error).message ?? String(err),
      }));
      if (extra) this.store.update(run.id, extra);
    }

    let next: AgentRun | null = null;
    if (rotate && run.attempt < run.maxAttempts) {
      next = this.store.insert(
        {
          project: run.project,
          taskId: run.taskId,
          taskTitle: run.taskTitle,
          role: run.role,
          attempt: run.attempt + 1,
          maxAttempts: run.maxAttempts,
          parentRunId: run.id,
          avoidKinds: run.avoidKinds,
          excludedProfiles: [...new Set([...run.excludedProfiles, profile.id])],
          instructions: run.instructions,
          reviewAfter: run.reviewAfter,
          baseSha: done.baseSha,
          ciFix: run.ciFix,
          bestOf: run.bestOf,
          requestedBy: run.requestedBy,
        },
        this.#iso(),
      );
      this.#opts.onEvent?.({ type: "rotated", run: done, next });
    } else if (run.bestOf) {
      // The group decides what comes next, once every candidate is done.
      await this.#bestOfNext(this.store.get(run.id)!).catch((err: unknown) => {
        const now = this.store.get(run.id)!;
        this.store.update(run.id, { error: [now.error, `best-of-n: ${(err as Error).message}`].filter(Boolean).join(" · ") });
      });
      void this.tick();
      return;
    } else if (status === "succeeded" && run.reviewAfter && run.role !== "review") {
      next = this.store.insert(
        {
          project: run.project,
          taskId: run.taskId,
          taskTitle: run.taskTitle,
          role: "review",
          attempt: 1,
          maxAttempts: run.maxAttempts,
          parentRunId: run.id,
          avoidKinds: [profile.kind],
          baseSha: done.baseSha,
          requestedBy: run.requestedBy,
        },
        this.#iso(),
      );
      this.#opts.onEvent?.({ type: "follow-up", run: done, next });
    }
    if (!next) this.#opts.onEvent?.({ type: "finished", run: this.store.get(run.id)! });
    // A hub that does not know runs.report yet (older version) just misses these notices.
    this.#track(this.#notifyHub(this.store.get(run.id)!, next).catch(() => undefined));
    void this.tick();
  }

  /**
   * After a candidate or the judge ended for good: once nothing of the group is left to run, asks a judge
   * (two or more candidates finished), keeps the only one that did, or gives the task back.
   */
  async #bestOfNext(run: AgentRun): Promise<void> {
    const b = run.bestOf!;
    const group = this.store.group(b.group);
    if (group.some((r) => r.bestOf!.pick !== null) || group.some((r) => ACTIVE.includes(r.status))) return;
    const finals = latestCandidates(group);
    const done = finals.filter((c) => c.status === "succeeded");
    const judge = group.filter((r) => r.bestOf!.n === 0).at(-1) ?? null;
    if (judge) {
      const pick = judge.status === "succeeded" ? parsePick(judge.summary, b.of) : null;
      const kept = pick ? done.find((c) => c.bestOf!.n === pick.n) : undefined;
      if (kept) {
        await this.#keep(kept, pick!.reason || tr("bestOf.noReason"), judge);
        return;
      }
      const why = pick ? tr("bestOf.pickedUnfinished", { n: pick.n }) : judge.status === "succeeded" ? tr("bestOf.noWinner") : (judge.error ?? judge.status);
      await this.#undecided(judge, done, why);
      return;
    }
    if (done.length === 1) {
      await this.#keep(done[0]!, tr("bestOf.onlyOne"), null);
      return;
    }
    if (!done.length) {
      await this.#groupFailed(finals);
      return;
    }
    // Another vendor than the candidates', when there is one.
    const kinds = this.#host.profiles().flatMap((p) => (done.some((c) => c.profileId === p.id) ? [p.kind] : []));
    const last = finals.at(-1)!;
    const next = this.store.insert(
      {
        project: last.project,
        taskId: last.taskId,
        taskTitle: last.taskTitle,
        role: "review",
        attempt: 1,
        maxAttempts: last.maxAttempts,
        avoidKinds: [...new Set(kinds)],
        instructions: last.instructions,
        reviewAfter: last.reviewAfter,
        baseSha: last.baseSha,
        bestOf: { ...b, n: 0 },
        requestedBy: last.requestedBy,
      },
      this.#iso(),
    );
    this.#opts.onEvent?.({ type: "judging", run, next });
  }

  /**
   * Keeps a candidate: its branch becomes ai/<task> (in the task's worktree), the candidates' worktrees go,
   * and the task goes on as after one implement run (review, or the MR).
   */
  async #keep(chosen: AgentRun, reason: string, judge: AgentRun | null): Promise<AgentRun> {
    const b = chosen.bestOf!;
    const project = this.#project(chosen.project);
    const root = this.#host.settings().worktreeRoot ?? path.join(this.#opts.dataDir, "worktrees");
    const from = chosen.branch ?? branchFor(candidateName(chosen.taskId, b.n));
    const wt = ensureWorktree(project.repo, path.join(root, project.name, chosen.taskId), chosen.taskId, chosen.baseSha);
    resetTo(wt.path, wt.branch, `refs/heads/${from}`);
    // After the reset: `git clean` takes the context with everything else untracked, and a review may follow here.
    await this.#writeContext(this.#host.backend(), this.#runnerActor(), chosen.project, wt);
    this.store.setPick(b.group, b.n, reason);
    // Their branches stay, for a look at what was not kept (Board → show changes).
    const notes: string[] = [];
    for (const c of this.store.group(b.group)) {
      if (!c.worktree || c.bestOf!.n === 0) continue;
      try {
        if (existsSync(c.worktree)) removeWorktree(project.repo, c.worktree, true);
      } catch (err) {
        notes.push((err as Error).message);
      }
      this.store.update(c.id, { worktree: null });
    }
    let kept = this.store.update(chosen.id, {
      branch: wt.branch,
      worktree: wt.path,
      ...branchState(wt.path, wt.baseSha),
      ...(notes.length ? { error: notes.join(" · ") } : {}),
    });
    const task = await this.#groupTask(kept, b.group);
    if (task) {
      const by = judge ? `, giám khảo ${judge.profileId ?? "?"} (run ${judge.id})` : "";
      const note =
        `${kept.summary ?? "Agent kết thúc không để lại tóm tắt."}\n\n` +
        `Best-of-${b.of}: giữ bản c${b.n} (run ${kept.id} · ${kept.profileId ?? "?"})${by}. ${reason}\n` +
        `Branch ${kept.branch}, ${kept.commits} commit${kept.headSha ? ` (${kept.headSha})` : ""}.`;
      await this.#host.backend().call("tasks.update", { id: kept.taskId, status: "review", note: clip(note, 2000) }, this.#runnerActor());
    }
    this.#owners.delete(b.group);
    let next: AgentRun | null = null;
    if (kept.reviewAfter) {
      const kind = this.#host.profiles().find((p) => p.id === kept.profileId)?.kind;
      next = this.store.insert(
        {
          project: kept.project,
          taskId: kept.taskId,
          taskTitle: kept.taskTitle,
          role: "review",
          attempt: 1,
          maxAttempts: kept.maxAttempts,
          parentRunId: kept.id,
          avoidKinds: kind ? [kind] : [],
          baseSha: kept.baseSha,
          requestedBy: kept.requestedBy,
        },
        this.#iso(),
      );
    } else if (this.#opts.afterFinish) {
      const extra = await this.#opts.afterFinish(kept).catch((err: unknown) => ({
        mrState: "failed" as const,
        mrNote: (err as Error).message ?? String(err),
      }));
      if (extra) kept = this.store.update(kept.id, extra);
    }
    this.#opts.onEvent?.({ type: "picked", run: kept, next });
    this.#track(this.#notifyHub(kept, next).catch(() => undefined));
    void this.tick();
    return kept;
  }

  /** The judge ran but chose nothing usable: the candidates wait for someone to pick one. */
  async #undecided(judge: AgentRun, done: AgentRun[], why: string): Promise<void> {
    const b = judge.bestOf!;
    const task = await this.#groupTask(judge, b.group);
    if (task) {
      const list = done.map((c) => `c${c.bestOf!.n} (${c.profileId ?? "?"}, ${c.branch ?? "?"})`).join(", ");
      const note = `Best-of-${b.of}: giám khảo ${judge.profileId ?? "?"} (run ${judge.id}) chưa chọn được bản nào: ${why}. Chọn tay một bản ở Board: ${list}.`;
      await this.#host.backend().call("tasks.update", { id: judge.taskId, status: "review", note: clip(note, 2000) }, this.#runnerActor());
    }
    this.#owners.delete(b.group);
    this.#opts.onEvent?.({ type: "undecided", run: judge });
  }

  /** No candidate finished: the task goes back to todo with what each one hit. */
  async #groupFailed(finals: AgentRun[]): Promise<void> {
    const last = [...finals].sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? "")).at(-1)!;
    const b = last.bestOf!;
    // Decided before the first await: two candidates that end together must not both give the task back.
    this.store.setPick(b.group, 0, "");
    const task = await this.#groupTask(last, b.group);
    if (task) {
      const lines = finals.map((c) => `c${c.bestOf!.n} (${c.profileId ?? "?"}) ${c.status}: ${c.error ?? ""}`);
      const note = `Best-of-${b.of}: không bản nào chạy xong.\n${lines.join("\n")}`;
      await this.#host.backend().call("tasks.update", { id: last.taskId, status: "todo", note: clip(note, 2000) }, this.#runnerActor());
    }
    this.#owners.delete(b.group);
    this.#opts.onEvent?.({ type: "finished", run: last });
    this.#track(this.#notifyHub(last, null).catch(() => undefined));
  }

  /** The task a group may move: not done, and not held by anyone but the group's runner. */
  async #groupTask(run: AgentRun, group: string): Promise<Task | null> {
    const task = (await this.#host.backend().call("tasks.list", { project: run.project }, this.#runnerActor())).find((t) => t.id === run.taskId);
    if (!task || task.status === "done") return null;
    if (!task.owner) return task;
    const owner = this.#owners.get(group);
    const me = this.#runnerActor().name;
    // After a restart the lease holder is unknown: a hub appends its token name to the runner's.
    return (owner ? task.owner === owner : task.owner === me || task.owner.startsWith(`${me}@`)) ? task : null;
  }

  /** Tells the hub, for its webhooks, about a run that failed with no attempt left, and a merge request it opened. */
  async #notifyHub(run: AgentRun, next: AgentRun | null): Promise<void> {
    if (this.#host.mode() !== "hub") return;
    const base = { project: run.project, taskId: run.taskId, taskTitle: run.taskTitle, runId: run.id, profileId: run.profileId, role: run.role };
    const notices = [
      ...(!next && (run.status === "failed" || run.status === "rate_limited") ? [{ kind: "failed" as const, ...base, error: run.error }] : []),
      ...(run.mrState === "created" && run.mrUrl ? [{ kind: "mr" as const, ...base, mrUrl: run.mrUrl, mrIid: run.mrIid }] : []),
    ];
    for (const notice of notices) await this.#host.backend().call("runs.report", notice, this.#runnerActor());
  }

  /** Moves the Hive task on, unless the agent already did it through MCP. */
  async #report(run: AgentRun, profile: AgentProfile): Promise<void> {
    // A best-of-n group reports once, for the kept candidate (#keep) or for all of them.
    if (!TERMINAL.includes(run.status) || run.bestOf) return;
    const backend = this.#host.backend();
    const actor = this.#actor(profile);
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    if (!task) return;
    const branch = run.branch ? `Branch ${run.branch}, ${run.commits} commit${run.headSha ? ` (${run.headSha})` : ""}.` : "";
    const sig = `Run ${run.id} · ${profile.id}`;

    if (run.role === "review") {
      if (run.status !== "succeeded" || !run.summary) return;
      const note = clip(`${task.note ? `${task.note}\n\n` : ""}Review (${sig}):\n${run.summary}`, 2000);
      await backend.call("tasks.update", { id: run.taskId, status: task.status, note }, actor);
      return;
    }
    const owner = this.#owners.get(run.id) ?? actor.name;
    this.#owners.delete(run.id);
    if (task.status !== "doing" || task.owner !== owner) return;
    const note =
      run.status === "succeeded"
        ? `${run.summary ?? "Agent kết thúc không để lại tóm tắt."}\n\n${branch} ${sig}.`
        : run.status === "rate_limited"
          ? `${profile.id} hết quota (${run.error}). Hive chuyển sang gói khác. ${branch} ${sig}.`
          : `${sig} ${run.status}: ${run.error ?? ""}. ${branch}`;
    await backend.call("tasks.update", { id: run.taskId, status: run.status === "succeeded" ? "review" : "todo", note: clip(note, 2000) }, actor);
  }
}
