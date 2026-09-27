// Runs coding-agent CLIs headless against Hive tasks and rotates subscriptions when one runs out of quota.
//
//   queued ──pick profile──▶ running ──exit 0──▶ succeeded ──(reviewAfter)──▶ review run on another vendor
//                               │ ├─ quota message ─▶ rate_limited ─▶ cooldown profile, new attempt elsewhere
//                               │ ├─ CLI missing ──▶ failed ─────────▶ short cooldown, new attempt elsewhere
//                               │ └─ other ────────▶ failed / cancelled
//
// No Electron imports: the desktop main process provides a RunnerHost, tests provide a fake one.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_ROLES,
  agentActorName,
  HiveError,
  type Actor,
  type AgentProfile,
  type AgentProfileStatus,
  type AgentRun,
  type DesktopProject,
  type HiveBackend,
  type RunnerSettings,
  type RunStatus,
  type StartRunRequest,
  type Task,
} from "@xdev-hive/core";
import { buildCommand, buildPrompt, describeCommand, expandEnv, resolveBin } from "./command.ts";
import { detectRateLimit } from "./rate-limit.ts";
import { pickProfile, waitingReason, type ProfileLoad, type RunNeeds } from "./schedule.ts";
import { RunStore } from "./store.ts";
import { branchState, commitAll, describeBranch, ensureWorktree, removeWorktree, type Worktree } from "./worktree.ts";

export interface RunnerHost {
  backend(): HiveBackend;
  profiles(): AgentProfile[];
  settings(): RunnerSettings;
  projects(): DesktopProject[];
  mode(): "local" | "hub";
  /** This machine's name in hub leases (config.machine). */
  machine(): string;
  /** Base env for agent processes (login-shell PATH etc.). */
  env(): NodeJS.ProcessEnv;
}

export type RunnerEvent =
  | { type: "finished"; run: AgentRun }
  | { type: "rotated"; run: AgentRun; next: AgentRun }
  | { type: "follow-up"; run: AgentRun; next: AgentRun };

export interface RunnerOptions {
  /** Holds runs.db, run logs and (by default) worktrees. */
  dataDir: string;
  user?: string;
  now?: () => Date;
  onEvent?: (event: RunnerEvent) => void;
  tickMs?: number;
  /** Rest for a profile whose CLI is missing, so rotation skips it for a while. */
  unavailableCooldownMinutes?: number;
  /**
   * Called for every finished run before follow-ups are queued (e.g. open a merge request).
   * Returned fields are saved on the run. Errors are recorded on the run, never fail it.
   */
  afterFinish?: (run: AgentRun) => Promise<Partial<AgentRun> | void>;
}

interface Live {
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
}

type Outcome =
  | { kind: "exit"; code: number | null; stdout: string; all: string; cancelled: boolean; timedOut: boolean }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; reason: string };

const TAIL_BYTES = 20_000;
const keepTail = (s: string) => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);
const clip = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);
const TERMINAL: RunStatus[] = ["succeeded", "failed", "rate_limited", "cancelled"];

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5000).unref();
}

export class Runner {
  readonly store: RunStore;
  readonly #host: RunnerHost;
  readonly #opts: Required<Omit<RunnerOptions, "onEvent" | "afterFinish">> & Pick<RunnerOptions, "onEvent" | "afterFinish">;
  readonly #live = new Map<string, Live>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #waiting = new Map<string, string>();
  /** Lease holder name as the backend recorded it (a hub appends the token name: claude-1.duy-mbp@duy). */
  readonly #owners = new Map<string, string>();
  #ticking = false;
  #again = false;
  #interval: NodeJS.Timeout | undefined;

  constructor(host: RunnerHost, opts: RunnerOptions) {
    this.#host = host;
    this.#opts = {
      user: os.userInfo().username,
      now: () => new Date(),
      tickMs: 5000,
      unavailableCooldownMinutes: 10,
      ...opts,
    };
    this.store = new RunStore(path.join(opts.dataDir, "runs.db"));
    mkdirSync(path.join(opts.dataDir, "runs"), { recursive: true });
  }

  start(): void {
    this.store.failInterrupted(this.#iso());
    this.#interval = setInterval(() => void this.tick(), this.#opts.tickMs);
    this.#interval.unref();
    void this.tick();
  }

  /** Cancels running agents and waits for their bookkeeping (commit, Hive update) to finish. */
  async stop(): Promise<void> {
    clearInterval(this.#interval);
    for (const id of this.#live.keys()) this.cancel(id);
    await Promise.allSettled([...this.#inflight]);
  }

  /** Resolves once nothing is running and no queued run can start. For tests and graceful quit. */
  async settle(): Promise<void> {
    for (;;) {
      await this.tick();
      if (!this.#inflight.size) return;
      await Promise.allSettled([...this.#inflight]);
    }
  }

  async enqueue(req: StartRunRequest): Promise<AgentRun> {
    const project = this.#host.projects().find((p) => p.name === req.project);
    if (!project) throw new HiveError("not_found", `Dự án ${req.project} chưa được thêm vào app.`);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(req.taskId)) throw new HiveError("bad_request", "Task id không hợp lệ.");
    const role = req.role ?? "implement";
    if (!AGENT_ROLES.includes(role)) throw new HiveError("bad_request", `Vai trò không hợp lệ: ${role}`);
    if (req.profileId && !this.#host.profiles().some((p) => p.id === req.profileId)) {
      throw new HiveError("not_found", `Không có profile ${req.profileId}.`);
    }
    const probe = this.#host.profiles().find((p) => p.id === req.profileId) ?? this.#host.profiles()[0];
    const actor: Actor = probe ? this.#actor(probe) : { name: "desktop", role: "agent" };
    const task = (await this.#host.backend().call("tasks.list", { project: req.project }, actor)).find((t) => t.id === req.taskId);
    if (!task) throw new HiveError("not_found", `Không có task ${req.taskId} trong dự án ${req.project}.`);
    if (task.status === "done") throw new HiveError("bad_request", `Task ${req.taskId} đã xong.`);
    const active = this.store.activeForTask(req.project, req.taskId);
    if (active) throw new HiveError("conflict", `Task ${req.taskId} đang có run ${active.id} (${active.status}).`);
    const previous = this.store.lastWithWorktree(req.project, req.taskId);
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
      },
      this.#iso(),
    );
    void this.tick();
    return run;
  }

  cancel(id: string): AgentRun {
    const run = this.store.get(id);
    if (!run) throw new HiveError("not_found", `Không có run ${id}.`);
    if (run.status === "queued") {
      this.#waiting.delete(id);
      return this.store.update(id, { status: "cancelled", finishedAt: this.#iso(), error: "Huỷ trước khi chạy" });
    }
    const live = this.#live.get(id);
    if (live) {
      live.cancelled = true;
      killTree(live.child);
    }
    return run;
  }

  list(filter: { project?: string; limit?: number } = {}): AgentRun[] {
    return this.store.list(filter).map((r) => (r.status === "queued" ? { ...r, error: this.#waiting.get(r.id) ?? r.error } : r));
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
    return (start > 0 ? "…(đã cắt phần đầu)\n" : "") + buf.toString("utf8");
  }

  diff(id: string): string {
    const run = this.store.get(id);
    if (!run?.worktree || !run.baseSha) return "Run chưa có worktree.";
    return describeBranch(run.worktree, run.baseSha);
  }

  removeWorktree(id: string): AgentRun {
    const run = this.store.get(id);
    if (!run?.worktree) throw new HiveError("not_found", "Run không có worktree.");
    if (this.store.activeForTask(run.project, run.taskId)) throw new HiveError("conflict", "Task đang có run hoạt động.");
    const project = this.#project(run.project);
    if (existsSync(run.worktree)) removeWorktree(project.repo, run.worktree);
    return run;
  }

  profileStatuses(): AgentProfileStatus[] {
    const now = this.#opts.now();
    return this.#host.profiles().map((profile) => {
      const s = this.store.profileStats(profile.id);
      const cd = this.store.cooldown(profile.id);
      const resting = cd && new Date(cd.until) > now ? cd : null;
      return {
        ...profile,
        running: s.running,
        lastUsedAt: s.lastUsedAt,
        stats: s.stats,
        cooldownUntil: resting?.until ?? null,
        cooldownReason: resting?.reason ?? null,
      };
    });
  }

  resetCooldown(profileId: string): void {
    this.store.clearCooldown(profileId);
    void this.tick();
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
          if (this.store.running() >= this.#host.settings().maxParallel) {
            this.#waiting.set(run.id, "Đang chờ slot trống (đã đạt số agent chạy song song)");
            continue;
          }
          const loads = this.#loads();
          const needs = this.#needs(run);
          const pick = pickProfile(loads, needs, now);
          if (!pick) {
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

  #iso(offsetMinutes = 0): string {
    return new Date(this.#opts.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  #logPath(id: string): string {
    return path.join(this.#opts.dataDir, "runs", `${id}.log`);
  }

  #project(name: string): DesktopProject {
    const p = this.#host.projects().find((x) => x.name === name);
    if (!p) throw new HiveError("not_found", `Dự án ${name} chưa được thêm vào app.`);
    return p;
  }

  #actor(profile: AgentProfile): Actor {
    // Same naming as the hive-mcp shim, so the agent's own task_claim/task_update match the runner's lease.
    return { name: agentActorName(profile.id, this.#host.mode(), this.#host.machine(), this.#opts.user), role: "agent" };
  }

  #loads(): ProfileLoad[] {
    return this.#host.profiles().map((profile) => {
      const s = this.store.profileStats(profile.id);
      return { profile, running: s.running, lastUsedAt: s.lastUsedAt, cooldownUntil: this.store.cooldown(profile.id)?.until ?? null };
    });
  }

  #needs(run: AgentRun): RunNeeds {
    return {
      role: run.role,
      preferredProfile: run.preferredProfile,
      avoidKinds: run.avoidKinds,
      excludedProfiles: run.excludedProfiles,
    };
  }

  async #task(backend: HiveBackend, actor: Actor, run: AgentRun): Promise<Task> {
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    if (!task) throw new HiveError("not_found", `Không có task ${run.taskId} trong dự án ${run.project}.`);
    return task;
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

  async #execute(run: AgentRun, profile: AgentProfile): Promise<void> {
    let wt: Worktree | null = null;
    let log: WriteStream | null = null;
    try {
      const project = this.#project(run.project);
      const root = this.#host.settings().worktreeRoot ?? path.join(this.#opts.dataDir, "worktrees");
      wt = ensureWorktree(project.repo, path.join(root, project.name, run.taskId), run.taskId, run.baseSha);
      const backend = this.#host.backend();
      const actor = this.#actor(profile);
      const task = await this.#task(backend, actor, run);
      run = this.store.update(run.id, { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, taskTitle: task.title });

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
      });
      const cmd = buildCommand(profile, { prompt, worktree: wt.path, task: run.taskId, project: run.project, branch: wt.branch });
      const base = this.#host.env();
      const bin = resolveBin(cmd.bin, base.PATH ?? "");
      if (!bin) {
        await this.#complete(run, profile, wt, { kind: "unavailable", reason: `Không tìm thấy lệnh "${cmd.bin}" trong PATH` });
        return;
      }

      if (run.role !== "review") {
        const lease = Math.min(profile.timeoutMinutes + 15, 24 * 60);
        const claim = await backend.call("tasks.claim", { id: run.taskId, leaseMinutes: lease }, actor);
        if (!claim.claimed) {
          throw new HiveError("conflict", `Task đang do ${claim.task?.owner ?? "người khác"} giữ đến ${claim.task?.leaseUntil ?? "?"}.`);
        }
        if (claim.task?.owner) this.#owners.set(run.id, claim.task.owner);
      }

      log = createWriteStream(this.#logPath(run.id), { flags: "a" });
      log.on("error", () => undefined); // a failing log file must not take the app down
      log.write(`$ ${describeCommand(cmd)}\n# cwd ${wt.path}\n# profile ${profile.id} · attempt ${run.attempt}/${run.maxAttempts} · role ${run.role}\n\n## Prompt\n${prompt}\n\n## Output\n`);

      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_"))),
        ...expandEnv(profile.env),
        HIVE_AGENT: profile.id,
        HIVE_PROJECT: run.project,
        HIVE_TASK: run.taskId,
        HIVE_RUN: run.id,
      };
      const child = spawn(bin, cmd.args, {
        cwd: wt.path,
        env,
        detached: process.platform !== "win32",
        stdio: [cmd.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const live: Live = { child, cancelled: false, timedOut: false };
      this.#live.set(run.id, live);
      const timer = setTimeout(() => {
        live.timedOut = true;
        killTree(child);
      }, profile.timeoutMinutes * 60_000);
      if (cmd.stdin !== null) child.stdin?.end(cmd.stdin);

      let stdout = "";
      let all = "";
      const out = log;
      child.stdout?.on("data", (b: Buffer) => {
        out.write(b);
        stdout = keepTail(stdout + b.toString("utf8"));
        all = keepTail(all + b.toString("utf8"));
      });
      child.stderr?.on("data", (b: Buffer) => {
        out.write(b);
        all = keepTail(all + b.toString("utf8"));
      });

      const outcome = await new Promise<Outcome>((resolve) => {
        child.once("error", (err) => resolve({ kind: "error", reason: `Không chạy được ${cmd.bin}: ${err.message}` }));
        child.once("close", (code) =>
          resolve({ kind: "exit", code, stdout, all, cancelled: live.cancelled, timedOut: live.timedOut }),
        );
      });
      clearTimeout(timer);
      this.#live.delete(run.id);
      out.write(`\n# exit ${outcome.kind === "exit" ? outcome.code : outcome.kind}\n`);
      await new Promise<void>((r) => out.end(r));
      log = null;
      await this.#complete(run, profile, wt, outcome);
    } catch (err) {
      log?.end();
      await this.#complete(run, profile, wt, { kind: "error", reason: (err as Error).message ?? String(err) });
    }
  }

  async #complete(run: AgentRun, profile: AgentProfile, wt: Worktree | null, outcome: Outcome): Promise<void> {
    const now = this.#opts.now();
    let status: RunStatus = "failed";
    let error: string | null = null;
    let rotate = false;
    let exitCode: number | null = null;
    let summary: string | null = null;

    if (outcome.kind === "unavailable") {
      error = outcome.reason;
      rotate = true;
      this.store.setCooldown(profile.id, this.#iso(this.#opts.unavailableCooldownMinutes), outcome.reason);
    } else if (outcome.kind === "error") {
      error = outcome.reason;
    } else {
      exitCode = outcome.code;
      summary = outcome.stdout.trim() ? clip(outcome.stdout.trim(), 1500) : null;
      const hit = outcome.code !== 0 && !outcome.cancelled ? detectRateLimit(outcome.all, now) : null;
      if (outcome.cancelled) {
        status = "cancelled";
        error = "Admin huỷ";
      } else if (outcome.timedOut) {
        error = `Quá thời gian ${profile.timeoutMinutes} phút`;
      } else if (outcome.code === 0) {
        status = "succeeded";
      } else if (hit) {
        status = "rate_limited";
        rotate = true;
        error = hit.reason;
        const until = hit.resetAt && hit.resetAt > now ? hit.resetAt.toISOString() : this.#iso(profile.cooldownMinutes);
        this.store.setCooldown(profile.id, until, hit.reason);
      } else {
        const lastErr = outcome.all.trim().split("\n").at(-1) ?? "";
        error = `Thoát với mã ${outcome.code ?? "?"}${lastErr ? `: ${clip(lastErr, 200)}` : ""}`;
      }
    }

    let commits = run.commits;
    let headSha = run.headSha;
    if (wt && existsSync(wt.path)) {
      const label = run.role === "review" ? "review" : status === "succeeded" ? "work" : "wip";
      const c = commitAll(wt.path, `ai(${run.taskId}): ${label} by ${profile.id}\n\nRun ${run.id}, attempt ${run.attempt}, status ${status}`, wt.copied);
      if (c.error) error = [error, `commit: ${c.error}`].filter(Boolean).join(" · ");
      ({ commits, headSha } = branchState(wt.path, wt.baseSha));
    }

    const done = this.store.update(run.id, { status, error, exitCode, summary, commits, headSha, finishedAt: now.toISOString() });
    await this.#report(done, profile).catch((err: unknown) => {
      this.store.update(run.id, { error: [done.error, `Hive: ${(err as Error).message}`].filter(Boolean).join(" · ") });
    });

    if (this.#opts.afterFinish) {
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
        },
        this.#iso(),
      );
      this.#opts.onEvent?.({ type: "rotated", run: done, next });
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
        },
        this.#iso(),
      );
      this.#opts.onEvent?.({ type: "follow-up", run: done, next });
    }
    if (!next) this.#opts.onEvent?.({ type: "finished", run: this.store.get(run.id)! });
    void this.tick();
  }

  /** Moves the Hive task on, unless the agent already did it through MCP. */
  async #report(run: AgentRun, profile: AgentProfile): Promise<void> {
    if (!TERMINAL.includes(run.status)) return;
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
