import type { RunStartInput, TaskStatus } from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import {
  type AuthedMachine,
  findMachine,
  isConnected,
  listOnlineMachines,
  type OutgoingMessage,
  type RunHandlers,
  type RunMessage,
  sendToMachine,
} from "../fleet/index.ts";
import { ConflictError, type Jobs, type MasterKey, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { isGitProviderError, loadConnection, type ProviderFactory } from "../scm/index.ts";
import { loadTask, setTaskStatus, type TaskRow, taskForUser } from "../tasks/index.ts";
import { evaluatePolicy, type Outcome } from "./policy.ts";
import { type RunResult, runEvents, runLeases, runLogs, runs } from "./schema.ts";
import { hubEvent, lockRun, notifyRun, ON_MACHINE, RUNS_CHANNEL, type RunRow, toRun, transition } from "./state.ts";
import { runTokenKey, signRunToken } from "./token.ts";

/** Hẹn giờ của run (hết hạn đề nghị job, kiểm lease, chạy lại verifying) đi qua một queue pg-boss. */
export const RUNS_TIMER_QUEUE = "runs-timer";
export const runsTimerQueue = {
  name: RUNS_TIMER_QUEUE,
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
} as const;

export type RunTimer =
  | { kind: "offer"; orgId: string; runId: string; attempt: number; machineId: string }
  | { kind: "lease"; orgId: string; runId: string; leaseId: string }
  | { kind: "verify"; orgId: string; runId: string };

export interface RunsDeps {
  /** Pool của hive_app. */
  pool: pg.Pool;
  publicUrl: string;
  /** HIVE_AUTH_SECRET: suy ra khoá ký run token. */
  authSecret: string;
  /** Giải mã kết nối Git để mở PR. */
  masterKey?: MasterKey | undefined;
  providerFactory: ProviderFactory;
  /**
   * Hẹn giờ bền qua pg-boss (sống qua lúc hub khởi động lại). Không có thì dùng setTimeout trong tiến trình, đủ cho
   * test và hub chạy một tiến trình không có hàng đợi.
   */
  jobs?: Jobs | undefined;
  /** Hạn của lease; worker gia hạn bằng heartbeat. Mặc định 90 giây (ba chu kỳ heartbeat). */
  leaseSec?: number | undefined;
  /** Thời gian máy có để trả lời job_offer. */
  offerTtlSec?: number | undefined;
  /** Thời gian worker có để dừng agent êm trước khi kill. */
  cancelGraceSec?: number | undefined;
  /** Chờ bao lâu rồi chạy lại verifying nếu hub chết giữa chừng. */
  verifyRetrySec?: number | undefined;
  send?: ((machineId: string, msg: OutgoingMessage) => boolean) | undefined;
  isConnected?: ((machineId: string) => boolean) | undefined;
  logger?: Pick<Console, "warn" | "error"> | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASE_STATE: Record<string, "preparing" | "running"> = {
  prepare: "preparing",
  preparing: "preparing",
  running: "running",
};
const pgError = (e: unknown) => ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint?: string };

const runNotFound = () => new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run trong tổ chức.");

/** Trạng thái task theo kết quả run: có PR thì chờ người review, không có gì để nộp hay lỗi thì quay về todo. */
function taskStatusFor(outcome: Outcome | "cancelled", prUrl: string | null): TaskStatus {
  if (outcome === "succeeded") return prUrl ? "review" : "done";
  if (outcome === "needs_review") return "review";
  return "todo";
}

function buildSpec(run: RunRow, task: TaskRow, project: ProjectRow, cli: string): Record<string, unknown> {
  return {
    kind: run.kind,
    taskId: task.id,
    taskKey: task.key,
    projectId: project.id,
    projectKey: project.key,
    title: task.title,
    prompt: task.body ? `${task.title}\n\n${task.body}` : task.title,
    cli,
    repoUrl: project.repoHttpUrl,
    baseBranch: project.defaultBranch,
    branch: run.branch,
    timeoutSec: run.timeoutSec,
  };
}

function prBody(task: TaskRow, run: RunRow, checks: RunResult["checks"]): string {
  const lines = [
    task.body ? task.body.slice(0, 4000) : "",
    "",
    `Task: ${task.key} · Run: ${run.id} (lần thử ${run.attempt})`,
    "",
    "Kiểm tra của hub:",
    ...checks.map((c) => `- ${c.passed ? "✅" : c.passed === null ? "⏸" : "❌"} ${c.check}: ${c.message}`),
  ];
  return lines.join("\n").trim();
}

/**
 * Lõi của module runs: giao job cho máy, lease, nhận gói của worker (fencing theo attempt), verifying và các hẹn giờ.
 * Gửi gói tới máy luôn làm sau khi transaction commit, để máy không nhận lệnh cho thay đổi đã rollback.
 */
export function createRunsEngine(deps: RunsDeps) {
  const leaseSec = deps.leaseSec ?? 90;
  const offerTtlSec = deps.offerTtlSec ?? 30;
  const graceSec = deps.cancelGraceSec ?? 30;
  const verifyRetrySec = deps.verifyRetrySec ?? 5 * 60;
  const send = deps.send ?? sendToMachine;
  const connected = deps.isConnected ?? isConnected;
  const log = deps.logger ?? console;
  const tokenKey = runTokenKey(deps.authSecret);
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId }, fn);
  const timers = new Set<NodeJS.Timeout>();
  const pendingNotify = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const background = (p: Promise<unknown>, what: string) => {
    p.catch((e: unknown) => log.error(what, e));
  };

  /** Hẹn giờ trong transaction khi có pg-boss: job chỉ thành hình khi transaction commit. */
  async function schedule(t: RunTimer, at: Date, tx?: Tx): Promise<void> {
    if (deps.jobs) {
      await deps.jobs.enqueue(RUNS_TIMER_QUEUE, t, { startAfter: at, tx });
      return;
    }
    if (stopped) return;
    const h = setTimeout(
      () => {
        timers.delete(h);
        background(fire(t), `Hẹn giờ ${t.kind} của run ${t.runId} lỗi`);
      },
      Math.max(0, at.getTime() - Date.now()),
    );
    h.unref();
    timers.add(h);
  }

  /**
   * Gom NOTIFY cho log: worker có thể gửi nhiều đoạn log mỗi giây, mà NOTIFY lấy khoá toàn cục lúc commit
   * (docs/architecture.md mục 9). Mỗi run nhiều nhất một NOTIFY mỗi 200 ms.
   */
  function notifyLater(runId: string) {
    if (pendingNotify.has(runId) || stopped) return;
    const h = setTimeout(() => {
      pendingNotify.delete(runId);
      background(deps.pool.query("select pg_notify($1, $2)", [RUNS_CHANNEL, runId]), "Không NOTIFY được log");
    }, 200);
    h.unref();
    pendingNotify.set(runId, h);
  }

  // ---- Giao job ----------------------------------------------------------------------------------------------

  /** Máy online, nối vào tiến trình này, có CLI phù hợp, chưa từ chối lần thử này và còn slot. */
  async function pickMachine(tx: Tx, run: RunRow) {
    const online = await listOnlineMachines(tx, run.teamId);
    const candidates = online.filter(
      (m) =>
        m.capacity > 0 &&
        connected(m.id) &&
        !run.rejectedBy.includes(m.id) &&
        (!run.pinnedMachineId || m.id === run.pinnedMachineId) &&
        (run.cli ? m.clis.includes(run.cli) : m.clis.length > 0),
    );
    for (const m of candidates) {
      // Khoá theo máy tới hết transaction để hai run không cùng lấy slot cuối của một máy. Thử khoá (không chờ):
      // máy đang được giao run khác thì xét máy kế tiếp, không xếp hàng chờ.
      const res = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`runs:machine:${m.id}`}, 0)) as locked`,
      );
      if (!res.rows[0]?.locked) continue;
      const [busy] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(
          or(
            and(eq(runs.machineId, m.id), inArray(runs.state, [...ON_MACHINE])),
            and(eq(runs.offerMachineId, m.id), eq(runs.state, "queued"), gt(runs.offerExpiresAt, new Date())),
          ),
        );
      if ((busy?.n ?? 0) < m.capacity) return m;
    }
    return null;
  }

  /** Đề nghị run `queued` cho một máy. Không có máy phù hợp thì giữ queued; máy rảnh ra sẽ gọi lại. */
  async function dispatch(orgId: string, runId: string): Promise<boolean> {
    const offer = await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.state !== "queued") return null;
      if (run.offerMachineId && run.offerExpiresAt && run.offerExpiresAt > new Date()) return null;
      const task = await loadTask(tx, run.taskId);
      const project = await loadProject(tx, run.projectId);
      if (!task || !project) return null;
      const machine = await pickMachine(tx, run);
      if (!machine) return null;
      const expiresAt = new Date(Date.now() + offerTtlSec * 1000);
      await tx
        .update(runs)
        .set({ offerMachineId: machine.id, offerExpiresAt: expiresAt, updatedAt: sql`now()` })
        .where(eq(runs.id, run.id));
      await hubEvent(tx, run, "offer", { machineId: machine.id, machine: machine.name });
      await notifyRun(tx, run.id);
      await schedule({ kind: "offer", orgId, runId, attempt: run.attempt, machineId: machine.id }, expiresAt, tx);
      const cli = run.cli ?? machine.clis[0] ?? "claude";
      return {
        machineId: machine.id,
        msg: {
          type: "job_offer",
          runId: run.id,
          attempt: run.attempt,
          ttl: offerTtlSec,
          spec: buildSpec(run, task, project, cli),
        } satisfies OutgoingMessage,
      };
    });
    if (!offer) return false;
    // Máy vừa rớt kết nối: hẹn giờ hết hạn đề nghị sẽ chuyển sang máy khác.
    if (!send(offer.machineId, offer.msg)) log.warn(`Không gửi được job_offer tới máy ${offer.machineId}`);
    return true;
  }

  /** Giao các run đang chờ của đội, cũ trước. Gọi khi máy vừa nối, vừa heartbeat hoặc vừa xong một run. */
  async function dispatchTeam(orgId: string, teamId: string): Promise<void> {
    const queued = await tenant(orgId, (tx) =>
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.teamId, teamId), eq(runs.state, "queued")))
        .orderBy(asc(runs.createdAt))
        .limit(20),
    );
    for (const { id } of queued) await dispatch(orgId, id);
  }

  // ---- Gói của worker ----------------------------------------------------------------------------------------

  async function onAccept(machine: AuthedMachine, msg: Extract<RunMessage, { type: "job_accept" }>) {
    const out = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (!run || run.attempt !== msg.attempt) return null;
      // job_accept gửi lại (worker nối lại trước khi nhận gói lease): gửi lại lease đang giữ.
      if (run.machineId === machine.id && ON_MACHINE.includes(run.state) && run.state !== "cancelling") {
        const [lease] = await tx.select().from(runLeases).where(eq(runLeases.runId, run.id));
        return lease ? { run, lease } : null;
      }
      if (run.state !== "queued" || run.offerMachineId !== machine.id) return null;
      await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
      const expiresAt = new Date(Date.now() + leaseSec * 1000);
      const [lease] = await tx
        .insert(runLeases)
        .values({
          orgId: run.orgId,
          teamId: run.teamId,
          runId: run.id,
          attempt: run.attempt,
          machineId: machine.id,
          expiresAt,
        })
        .returning();
      if (!lease) throw new Error("Không ghi được lease.");
      const leased = await transition(
        tx,
        run,
        "leased",
        { machineId: machine.id, offerMachineId: null, offerExpiresAt: null, startedAt: run.startedAt ?? new Date() },
        { machineId: machine.id, leaseId: lease.id },
      );
      await setTaskStatus(tx, run.taskId, "running");
      await schedule({ kind: "lease", orgId: run.orgId, runId: run.id, leaseId: lease.id }, expiresAt, tx);
      return { run: leased, lease };
    });
    if (!out) {
      // Đề nghị đã hết hạn và chuyển cho máy khác, hoặc run đã bị huỷ: bảo máy đừng chạy.
      send(machine.id, { type: "cancel", runId: msg.runId, graceSec: 0 });
      return;
    }
    const { token } = signRunToken(tokenKey, deps.publicUrl, {
      runId: out.run.id,
      taskId: out.run.taskId,
      orgId: out.run.orgId,
      attempt: out.run.attempt,
      ttlSec: out.run.timeoutSec,
    });
    send(machine.id, {
      type: "lease",
      runId: out.run.id,
      attempt: out.run.attempt,
      leaseId: out.lease.id,
      expiresAt: out.lease.expiresAt.toISOString(),
      runToken: token,
    });
  }

  async function onReject(machine: AuthedMachine, msg: Extract<RunMessage, { type: "job_reject" }>) {
    const moved = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (run?.state !== "queued" || run.attempt !== msg.attempt || run.offerMachineId !== machine.id) {
        return false;
      }
      await tx
        .update(runs)
        .set({
          rejectedBy: [...run.rejectedBy, machine.id],
          offerMachineId: null,
          offerExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, run.id));
      await hubEvent(tx, run, "offer_rejected", { machineId: machine.id, reason: msg.reason });
      await notifyRun(tx, run.id);
      return true;
    });
    if (moved) await dispatch(machine.orgId, msg.runId);
  }

  /**
   * Run nhận gói của máy này ở lần thử này. Gói của attempt cũ (worker treo rồi sống lại sau khi run đã giao lại)
   * hoặc của máy khác bị bỏ, để không ghi đè run đang chạy ở nơi khác (fencing, mục 4.1).
   */
  async function fenced(tx: Tx, machine: AuthedMachine, runId: string, attempt: number): Promise<RunRow | null> {
    const run = await lockRun(tx, runId);
    if (!run || run.attempt !== attempt || run.machineId !== machine.id || !ON_MACHINE.includes(run.state)) return null;
    return run;
  }

  async function onRunEvent(machine: AuthedMachine, msg: Extract<RunMessage, { type: "run_event" }>) {
    const accepted = await tenant(machine.orgId, async (tx) => {
      const run = await fenced(tx, machine, msg.runId, msg.attempt);
      if (!run) return false;
      const inserted = await tx
        .insert(runEvents)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          type: msg.event,
          data: msg.data,
        })
        .onConflictDoNothing()
        .returning({ id: runEvents.id });
      if (inserted.length === 0) return true;
      const to = msg.event === "phase" ? PHASE_STATE[String(msg.data.phase)] : undefined;
      const forward =
        (to === "preparing" && run.state === "leased") ||
        (to === "running" && (run.state === "leased" || run.state === "preparing"));
      if (to && forward) await transition(tx, run, to);
      else await notifyRun(tx, run.id);
      return true;
    });
    if (!accepted) log.warn(`Bỏ run_event của lần thử cũ hoặc máy lạ: run ${msg.runId}, attempt ${msg.attempt}`);
    // Vẫn ack gói bị bỏ, để worker xoá khỏi bộ đệm thay vì gửi lại mãi.
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
  }

  async function onLogChunk(machine: AuthedMachine, msg: Extract<RunMessage, { type: "log_chunk" }>) {
    const inserted = await tenant(machine.orgId, async (tx) => {
      const run = await fenced(tx, machine, msg.runId, msg.attempt);
      if (!run) return false;
      const rows = await tx
        .insert(runLogs)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          offset: msg.offset,
          data: Buffer.from(msg.bytes, "base64"),
        })
        .onConflictDoNothing()
        .returning({ id: runLogs.id });
      return rows.length > 0;
    });
    if (inserted) notifyLater(msg.runId);
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
  }

  async function onRunResult(machine: AuthedMachine, msg: Extract<RunMessage, { type: "run_result" }>) {
    const next = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (!run || run.attempt !== msg.attempt || run.machineId !== machine.id) return null;
      const inserted = await tx
        .insert(runEvents)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          type: "result",
          data: { exit: msg.exit, headSha: msg.headSha, report: msg.report },
        })
        .onConflictDoNothing()
        .returning({ id: runEvents.id });
      // Gói gửi lại, hoặc run đã kết thúc theo đường khác (hết lease): chỉ ack.
      if (inserted.length === 0 || !ON_MACHINE.includes(run.state)) return null;
      // Agent đã xong: máy không cần giữ lease nữa, slot trống cho run khác.
      await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
      if (run.state === "cancelling") {
        await finishCancelled(tx, run, {});
        return "cancelled" as const;
      }
      await transition(tx, run, "verifying", { headSha: msg.headSha }, { exit: msg.exit });
      // Hub chết giữa verifying thì hẹn giờ này chạy lại; verify bỏ qua run không còn ở verifying.
      await schedule(
        { kind: "verify", orgId: run.orgId, runId: run.id },
        new Date(Date.now() + verifyRetrySec * 1000),
        tx,
      );
      return "verify" as const;
    });
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
    if (next === "verify") background(verify(machine.orgId, msg.runId), `verifying run ${msg.runId} lỗi`);
    if (next) background(dispatchTeam(machine.orgId, machine.teamId), "Không giao được run đang chờ");
  }

  const handlers: Required<RunHandlers> = {
    async onHello(machine) {
      try {
        await dispatchTeam(machine.orgId, machine.teamId);
      } catch (e) {
        log.error("Không giao được run khi máy nối", e);
      }
    },

    async onHeartbeat(machine, msg) {
      const result = await tenant(machine.orgId, async (tx) => {
        const renewed: string[] = [];
        const cancel: string[] = [];
        const expiresAt = new Date(Date.now() + leaseSec * 1000);
        for (const r of msg.runs) {
          if (!UUID.test(r.leaseId) || !UUID.test(r.runId)) {
            cancel.push(r.runId);
            continue;
          }
          const [row] = await tx
            .select({ leaseAttempt: runLeases.attempt, state: runs.state, attempt: runs.attempt })
            .from(runLeases)
            .innerJoin(runs, eq(runs.id, runLeases.runId))
            .where(and(eq(runLeases.id, r.leaseId), eq(runLeases.runId, r.runId), eq(runLeases.machineId, machine.id)));
          const live =
            row && row.attempt === r.attempt && row.leaseAttempt === r.attempt && ON_MACHINE.includes(row.state);
          // Run đang huỷ không được gia hạn: hết lease là hạn cứng của lệnh huỷ.
          if (!live || row.state === "cancelling") {
            cancel.push(r.runId);
            continue;
          }
          await tx.update(runLeases).set({ expiresAt }).where(eq(runLeases.id, r.leaseId));
          renewed.push(r.leaseId);
        }
        return { renewed, cancel };
      });
      background(dispatchTeam(machine.orgId, machine.teamId), "Không giao được run đang chờ");
      return result;
    },

    async onMessage(machine, msg) {
      if (!UUID.test(msg.runId)) return;
      switch (msg.type) {
        case "job_accept":
          return onAccept(machine, msg);
        case "job_reject":
          return onReject(machine, msg);
        case "run_event":
          return onRunEvent(machine, msg);
        case "log_chunk":
          return onLogChunk(machine, msg);
        case "run_result":
          return onRunResult(machine, msg);
      }
    },
  };

  // ---- verifying ---------------------------------------------------------------------------------------------

  /** Chạy chính sách kết quả, mở PR khi thành công. Gọi ra nhà cung cấp Git ngoài transaction. */
  async function verify(orgId: string, runId: string): Promise<void> {
    const ctx = await tenant(orgId, async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      if (run?.state !== "verifying") return null;
      const [result] = await tx
        .select({ data: runEvents.data })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "result")))
        .orderBy(desc(runEvents.id))
        .limit(1);
      const [report] = await tx
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "agent_report")))
        .limit(1);
      const project = await loadProject(tx, run.projectId);
      const task = await loadTask(tx, run.taskId);
      const conn = project && deps.masterKey ? await loadConnection(tx, deps.masterKey, project.scmConnectionId) : null;
      return { run, data: result?.data ?? {}, hasAgentReport: Boolean(report), project, task, conn };
    });
    if (!ctx) return;
    const { run, data, project, task } = ctx;
    const report = (data.report ?? null) as Record<string, unknown> | null;
    const ev = evaluatePolicy(run.policySnapshot, {
      exit: typeof data.exit === "number" ? data.exit : 1,
      headSha: typeof data.headSha === "string" ? data.headSha : null,
      report,
      hasAgentReport: ctx.hasAgentReport,
    });
    let outcome = ev.outcome;
    const reasons = [...ev.reasons];
    let prUrl: string | null = null;
    if (outcome === "succeeded" && ev.hasChanges) {
      try {
        if (!project || !task) throw new Error("Dự án hoặc task không còn.");
        if (!ctx.conn) throw new Error("Hub chưa cấu hình HIVE_MASTER_KEY hoặc dự án mất kết nối Git.");
        const pr = await deps.providerFactory(ctx.conn).openPR(
          { owner: project.repoOwner, name: project.repoName },
          {
            head: run.branch,
            base: project.defaultBranch ?? "main",
            title: `${task.key}: ${task.title}`,
            body: prBody(task, run, ev.checks),
          },
        );
        prUrl = pr.url;
      } catch (e) {
        // Lỗi tạm thời: để run ở verifying, hẹn giờ verify sẽ thử lại.
        if (isGitProviderError(e) && e.retryable) throw e;
        outcome = "needs_review";
        reasons.push(`Không mở được PR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await tenant(orgId, async (tx) => {
      const locked = await lockRun(tx, runId);
      if (locked?.state !== "verifying") return;
      const result: RunResult = {
        exit: typeof data.exit === "number" ? data.exit : null,
        commitCount: ev.commitCount,
        changedFiles: ev.changedFiles,
        checks: ev.checks,
        reasons,
        report,
      };
      await transition(tx, locked, outcome, { result, prUrl, finishedAt: new Date() }, { reasons, prUrl });
      await setTaskStatus(tx, locked.taskId, taskStatusFor(outcome, prUrl));
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: locked.id,
        data: { outcome, prUrl, taskId: locked.taskId },
      });
    });
    // Chưa có module notify trên main; khi có, run failed gửi thông báo cho nhóm quản trị ở đây.
  }

  // ---- Hẹn giờ ---------------------------------------------------------------------------------------------

  async function onOfferTimeout(t: Extract<RunTimer, { kind: "offer" }>) {
    const moved = await tenant(t.orgId, async (tx) => {
      const run = await lockRun(tx, t.runId);
      if (
        run?.state !== "queued" ||
        run.attempt !== t.attempt ||
        run.offerMachineId !== t.machineId ||
        (run.offerExpiresAt && run.offerExpiresAt > new Date())
      ) {
        return false;
      }
      // Máy im lặng được coi như từ chối, để lần sau đề nghị máy khác thay vì hỏi lại máy không trả lời.
      await tx
        .update(runs)
        .set({
          rejectedBy: [...run.rejectedBy, t.machineId],
          offerMachineId: null,
          offerExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, run.id));
      await hubEvent(tx, run, "offer_expired", { machineId: t.machineId });
      await notifyRun(tx, run.id);
      return true;
    });
    if (moved) await dispatch(t.orgId, t.runId);
  }

  /** Lease hết hạn mà không có heartbeat: run sang lost rồi thử lại nếu còn lượt, hết lượt thì failed. */
  async function onLeaseTimeout(t: Extract<RunTimer, { kind: "lease" }>) {
    const out = await tenant(t.orgId, async (tx) => {
      const run = await lockRun(tx, t.runId);
      const [lease] = await tx.select().from(runLeases).where(eq(runLeases.id, t.leaseId));
      if (!run || !lease) return null;
      if (lease.expiresAt > new Date()) return { recheckAt: lease.expiresAt };
      await tx.delete(runLeases).where(eq(runLeases.id, lease.id));
      if (lease.attempt !== run.attempt || !ON_MACHINE.includes(run.state)) return null;
      if (run.state === "cancelling") {
        await finishCancelled(tx, run, { reason: "Máy không xác nhận lệnh huỷ trước khi hết lease." });
        return null;
      }
      const lost = await transition(tx, run, "lost", {}, { machineId: run.machineId, leaseId: lease.id });
      if (run.attempt < run.maxAttempts) {
        await transition(
          tx,
          lost,
          "queued",
          { attempt: run.attempt + 1, machineId: null, rejectedBy: [], offerMachineId: null, offerExpiresAt: null },
          { retry: run.attempt + 1 },
        );
        await setTaskStatus(tx, run.taskId, "queued");
        return { requeued: true };
      }
      const reasons = [`Mất kết nối với máy; đã thử ${run.attempt}/${run.maxAttempts} lần.`];
      await transition(
        tx,
        lost,
        "failed",
        {
          finishedAt: new Date(),
          result: { exit: null, commitCount: null, changedFiles: [], checks: [], reasons },
        },
        { reasons },
      );
      await setTaskStatus(tx, run.taskId, "todo");
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { outcome: "failed", reasons },
      });
      return null;
    });
    if (out && "recheckAt" in out) await schedule(t, out.recheckAt);
    else if (out?.requeued) await dispatch(t.orgId, t.runId);
  }

  async function fire(t: RunTimer): Promise<void> {
    if (t.kind === "offer") return onOfferTimeout(t);
    if (t.kind === "lease") return onLeaseTimeout(t);
    return verify(t.orgId, t.runId);
  }

  // ---- Huỷ ---------------------------------------------------------------------------------------------------

  async function finishCancelled(tx: Tx, run: RunRow, data: Record<string, unknown>): Promise<RunRow> {
    await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
    const row = await transition(
      tx,
      run,
      "cancelled",
      { finishedAt: new Date(), offerMachineId: null, offerExpiresAt: null },
      data,
    );
    await setTaskStatus(tx, run.taskId, "todo");
    return row;
  }

  /** Huỷ run đã khoá. Trả việc gửi lệnh huỷ tới máy, làm sau khi commit. */
  async function cancelLocked(tx: Tx, run: RunRow, by: string): Promise<{ row: RunRow; after: () => void }> {
    const noop = () => {};
    if (run.state === "cancelling") return { row: run, after: noop };
    if (run.state === "verifying") {
      throw new ConflictError("RUN_VERIFYING", "Run đang kiểm kết quả, không huỷ được nữa.");
    }
    if (["succeeded", "no_changes", "needs_review", "failed", "cancelled"].includes(run.state)) {
      throw new ConflictError("RUN_FINISHED", "Run đã kết thúc.");
    }
    if (ON_MACHINE.includes(run.state) && run.machineId) {
      const row = await transition(tx, run, "cancelling", {}, { by });
      const machineId = run.machineId;
      return { row, after: () => send(machineId, { type: "cancel", runId: run.id, graceSec }) };
    }
    // Chưa máy nào giữ (queued, chờ duyệt plan, lost): huỷ ngay; máy đang được đề nghị thì báo bỏ đề nghị.
    const offered = run.offerMachineId;
    const row = await finishCancelled(tx, run, { by });
    return { row, after: offered ? () => send(offered, { type: "cancel", runId: run.id, graceSec: 0 }) : noop };
  }

  // ---- API cho người dùng ------------------------------------------------------------------------------------

  async function startRun(tx: Tx, userId: string, input: RunStartInput) {
    const task = await taskForUser(tx, userId, input.taskId, "member");
    if (task.status === "cancelled" || task.status === "done") {
      throw new ConflictError("TASK_CLOSED", "Task đã xong hoặc đã huỷ, không giao được.");
    }
    const project = await loadProject(tx, task.projectId);
    if (project?.state !== "active" || !project.repoHttpUrl || !project.defaultBranch) {
      throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa khởi tạo xong repo, chưa giao task được.");
    }
    if (input.machineId) {
      const m = await findMachine(tx, input.machineId);
      if (!m || m.teamId !== task.teamId || m.revoked) {
        throw new NotFoundError("MACHINE_NOT_FOUND", "Không tìm thấy máy của đội sở hữu dự án.");
      }
    }
    const outcome = project.settings.outcome;
    const policy = (task.type ? outcome.byType[task.type] : undefined) ?? outcome.default;
    let row: RunRow | undefined;
    try {
      [row] = await tx
        .insert(runs)
        .values({
          orgId: sql`hive.ctx_org()`,
          teamId: task.teamId,
          taskId: task.id,
          projectId: project.id,
          cli: input.cli ?? task.preferredCli ?? null,
          pinnedMachineId: input.machineId ?? null,
          branch: `ai/${task.key}`,
          policySnapshot: policy,
          createdBy: userId,
        })
        .returning();
    } catch (e) {
      const pg = pgError(e);
      if (pg.code === "23505" && pg.constraint === "runs_task_active") {
        throw new ConflictError("RUN_ACTIVE", "Task đang có run chưa kết thúc.");
      }
      throw e;
    }
    if (!row) throw new Error("Không ghi được run.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: userId });
    await notifyRun(tx, row.id);
    await setTaskStatus(tx, task.id, "queued");
    await recordAudit(tx, {
      action: "run.start",
      targetType: "run",
      targetId: row.id,
      data: { taskId: task.id, cli: row.cli, machineId: row.pinnedMachineId },
    });
    const { orgId, id } = row;
    return { run: toRun(row), afterCommit: () => background(dispatch(orgId, id), "Không giao được run") };
  }

  async function cancelRun(tx: Tx, userId: string, id: string) {
    const found = await runForUser(tx, userId, id, "member");
    const run = await lockRun(tx, found.id);
    if (!run) throw runNotFound();
    const { row, after } = await cancelLocked(tx, run, userId);
    await recordAudit(tx, { action: "run.cancel", targetType: "run", targetId: run.id, data: { from: run.state } });
    return { run: toRun(row), afterCommit: after };
  }

  /** Huỷ mọi run chưa kết thúc của task (tasks.cancel). */
  async function cancelRunsOfTask(tx: Tx, taskId: string): Promise<() => void> {
    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, taskId),
          notInArray(runs.state, ["succeeded", "no_changes", "needs_review", "failed", "cancelled"]),
        ),
      );
    const afters: Array<() => void> = [];
    for (const { id } of active) {
      const run = await lockRun(tx, id);
      if (!run || run.state === "verifying") continue;
      afters.push((await cancelLocked(tx, run, "task.cancel")).after);
    }
    return () => {
      for (const a of afters) a();
    };
  }

  return {
    handlers,
    dispatch,
    dispatchTeam,
    verify,
    fire,
    startRun,
    cancelRun,
    cancelRunsOfTask,
    /** Xử lý hẹn giờ trên pg-boss; chỉ gọi ở tiến trình có vai trò `jobs` (cùng tiến trình với gateway). */
    async registerJobs(jobs: Jobs) {
      await jobs.work<RunTimer>(RUNS_TIMER_QUEUE, (job) => fire(job.data), { pollingIntervalSeconds: 1 });
    },
    stop() {
      stopped = true;
      for (const h of timers) clearTimeout(h);
      for (const h of pendingNotify.values()) clearTimeout(h);
      timers.clear();
      pendingNotify.clear();
    },
  };
}

export type RunsEngine = ReturnType<typeof createRunsEngine>;

/** Run mà người dùng có ít nhất vai trò `min` trong đội sở hữu; không thấy được thì báo như không tồn tại. */
export async function runForUser(
  tx: Tx,
  userId: string,
  id: string,
  min: "viewer" | "member" | "admin",
): Promise<RunRow> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id));
  if (!row) throw runNotFound();
  await taskForUser(tx, userId, row.taskId, min).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw runNotFound();
    throw e;
  });
  return row;
}
