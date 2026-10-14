import { randomUUID } from "node:crypto";
import {
  type LearnTrigger,
  SKILL_LEARNING_MAX_PER_RUN,
  SKILL_LEARNING_MAX_RUNS,
  type SkillProposalDraft,
  skillProposalSubmitInput,
} from "@xdev-hive/contracts";
import { and, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { loadPolicy } from "../governance/index.ts";
import {
  currentSkillContent,
  findSkillForProject,
  type LearningCorpus,
  type SkillRepoDeps,
  skillLearningCorpus,
} from "../knowledge/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { runEvents, runs } from "../runs/index.ts";
import { type DedupeCorpus, duplicateReason, findDuplicate, type NamedText } from "./dedupe.ts";
import { skillProposalPrompt, type TaskDigest } from "./digest.ts";
import { loadDigest } from "./load.ts";
import { learnedSkillProposals, skillLearningBatches, skillLearningMarks } from "./schema.ts";
import { FIRST_LOOKBACK_DAYS, selectCandidates } from "./select.ts";

/**
 * Cổng tạo run `skill_proposal` do lõi giao run cài vào (main.ts): module này phụ thuộc runs để đọc run, nên runs không
 * import ngược lại (cùng cách với `startReviewRuns` của codereview).
 */
export interface SkillRunPort {
  createRun(
    tx: Tx,
    input: { projectId: string; batchId: string; prompt: string },
  ): Promise<
    { ok: true; runId: string; afterCommit: () => void } | { ok: false; reason: "project_not_ready" | "no_machine" }
  >;
}

export interface SkillLearningDeps extends SkillRepoDeps {
  runs?: SkillRunPort | undefined;
  jobs?: Jobs | undefined;
  /** Thời điểm hiện tại; test đặt để kiểm lô theo ngày. */
  now?: (() => Date) | undefined;
  logger?: Pick<Console, "warn" | "error"> | undefined;
}

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const startOfDay = (d: Date) => new Date(`${dayOf(d)}T00:00:00.000Z`);

/** Đề xuất hub đã nhận hôm nay (UTC) của cả tổ chức, mọi trạng thái: đây là thứ hạn mức đếm. */
export async function proposalsToday(tx: Tx, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(learnedSkillProposals)
    .where(gte(learnedSkillProposals.createdAt, startOfDay(now)));
  return row?.n ?? 0;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Đề xuất bị từ chối hoặc đang chờ của dự án, để lô sau không đề xuất lại. */
async function knownProposals(tx: Tx, projectId: string) {
  const rows = await tx
    .select({
      name: learnedSkillProposals.name,
      description: learnedSkillProposals.description,
      status: learnedSkillProposals.status,
    })
    .from(learnedSkillProposals)
    .where(
      and(
        eq(learnedSkillProposals.projectId, projectId),
        inArray(learnedSkillProposals.status, ["pending", "rejected"]),
      ),
    )
    .orderBy(desc(learnedSkillProposals.createdAt))
    .limit(200);
  return {
    rejected: rows.filter((r) => r.status === "rejected").map((r): NamedText => r),
    pending: rows.filter((r) => r.status === "pending").map((r): NamedText => r),
  };
}

const toDedupe = (corpus: LearningCorpus, known: Awaited<ReturnType<typeof knownProposals>>): DedupeCorpus => ({
  skills: corpus.skills,
  packNames: corpus.packNames,
  memories: corpus.memories,
  ...known,
});

// ---- Lên lô -----------------------------------------------------------------------------------------------------

export interface PlanResult {
  /** Lô đã tạo run agent. */
  started: number;
  /** Lô không có run đáng học (chỉ ghi mốc để ngày mai không xét lại). */
  empty: number;
  /** Dự án có việc đáng học nhưng chưa có máy chạy: thử lại ở lần hẹn giờ sau. */
  waiting: number;
}

/**
 * Lô hằng ngày của một tổ chức (specs/014 FR-002): mỗi dự án có hoạt động gần đây và chưa có lô hôm nay thì chọn run
 * đáng học; có thì giao một run `skill_proposal`, không có thì chỉ ghi lô rỗng. Hết hạn mức ngày thì dừng, vì mỗi lô
 * đang chạy giữ trước ít nhất một đề xuất. Chạy lại trong ngày an toàn: (dự án, ngày) là khoá duy nhất.
 */
export async function planSkillLearning(deps: SkillLearningDeps, orgId: string): Promise<PlanResult> {
  const result: PlanResult = { started: 0, empty: 0, waiting: 0 };
  if (!deps.runs) return result;
  const now = (deps.now ?? (() => new Date()))();
  const day = dayOf(now);
  const setup = await withTenant(deps.pool, { orgId }, async (tx) => {
    const policy = await loadPolicy(tx);
    if (!policy.skillLearning.enabled) return null;
    const [reserved] = await tx
      .select({ n: count() })
      .from(skillLearningBatches)
      .where(and(eq(skillLearningBatches.day, day), eq(skillLearningBatches.status, "running")));
    const remaining = policy.skillLearning.maxPerDay - (await proposalsToday(tx, now)) - (reserved?.n ?? 0);
    const since = new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000);
    const recent = await tx
      .selectDistinct({ projectId: runs.projectId })
      .from(runs)
      .where(and(eq(runs.kind, "code"), gt(runs.finishedAt, since)));
    const marked = await tx
      .selectDistinct({ projectId: runs.projectId })
      .from(runs)
      .innerJoin(skillLearningMarks, eq(skillLearningMarks.runId, runs.id));
    const done = await tx
      .select({ projectId: skillLearningBatches.projectId })
      .from(skillLearningBatches)
      .where(eq(skillLearningBatches.day, day));
    const doneIds = new Set(done.map((d) => d.projectId));
    const projects = [...new Set([...recent, ...marked].map((p) => p.projectId))].filter((id) => !doneIds.has(id));
    return { remaining, projects };
  });
  if (!setup) return result;
  let remaining = setup.remaining;
  for (const projectId of setup.projects) {
    if (remaining <= 0) break;
    const outcome = await planProject(deps, orgId, projectId, now, remaining);
    if (outcome === "started") {
      result.started++;
      remaining--;
    } else if (outcome === "empty") result.empty++;
    else if (outcome === "waiting") result.waiting++;
  }
  return result;
}

async function planProject(
  deps: SkillLearningDeps,
  orgId: string,
  projectId: string,
  now: Date,
  limit: number,
): Promise<"started" | "empty" | "waiting" | "skipped"> {
  const day = dayOf(now);
  const planned = await withTenant(deps.pool, { orgId }, async (tx) => {
    // Hai lần hẹn giờ chồng nhau không cùng tạo run cho một dự án.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`skilllearn:${projectId}`}, 0))`);
    const [today] = await tx
      .select({ id: skillLearningBatches.id })
      .from(skillLearningBatches)
      .where(and(eq(skillLearningBatches.projectId, projectId), eq(skillLearningBatches.day, day)));
    if (today) return { outcome: "skipped" as const };
    const project = await findProject(tx, projectId);
    if (!project) return { outcome: "skipped" as const };
    const [last] = await tx
      .select({ windowTo: skillLearningBatches.windowTo })
      .from(skillLearningBatches)
      .where(eq(skillLearningBatches.projectId, projectId))
      .orderBy(desc(skillLearningBatches.windowTo))
      .limit(1);
    const from = last?.windowTo ?? new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000);
    const batch = { orgId, teamId: project.teamId, projectId, day, windowFrom: from, windowTo: now };
    const candidates = await selectCandidates(tx, projectId, { from, to: now }, SKILL_LEARNING_MAX_RUNS);
    if (!candidates.length) {
      await tx.insert(skillLearningBatches).values({ ...batch, status: "empty", finishedAt: now });
      return { outcome: "empty" as const };
    }
    const digests: TaskDigest[] = [];
    for (const c of candidates) {
      const d = await loadDigest(tx, c);
      if (d) digests.push(d);
    }
    const corpus = await skillLearningCorpus(tx, projectId);
    const known = await knownProposals(tx, projectId);
    const batchId = randomUUID();
    const started = await deps.runs?.createRun(tx, {
      projectId,
      batchId,
      prompt: skillProposalPrompt({
        projectKey: project.key,
        digests,
        existing: corpus.skills,
        rejected: known.rejected,
        limit,
      }),
    });
    if (!started) return { outcome: "skipped" as const };
    if (!started.ok) return { outcome: "waiting" as const };
    await tx.insert(skillLearningBatches).values({
      ...batch,
      id: batchId,
      status: "running",
      runId: started.runId,
      candidates: Object.fromEntries(
        candidates.flatMap((c) => c.runIds.map((id): [string, LearnTrigger[]] => [id, c.triggers])),
      ),
    });
    await recordAudit(tx, {
      action: "skill_learning.batch.start",
      actorUserId: null,
      targetType: "skill_learning_batch",
      targetId: batchId,
      data: { projectId, runId: started.runId, candidates: candidates.length },
    });
    return { outcome: "started" as const, afterCommit: started.afterCommit };
  });
  if ("afterCommit" in planned) planned.afterCommit();
  return planned.outcome;
}

// ---- Nhận đề xuất -----------------------------------------------------------------------------------------------

const TERMINAL = ["succeeded", "no_changes", "needs_review", "failed", "cancelled"] as const;

/**
 * Nhận kết quả các lô đang chạy khi run `skill_proposal` đã kết thúc: lọc từng đề xuất (trùng, không đổi, vượt hạn
 * mức) rồi lưu phần còn lại chờ duyệt. Trả số đề xuất mới.
 */
export async function ingestSkillLearning(deps: SkillLearningDeps, orgId: string): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const pending = await withTenant(deps.pool, { orgId }, (tx) =>
    tx
      .select({ id: skillLearningBatches.id })
      .from(skillLearningBatches)
      .where(eq(skillLearningBatches.status, "running")),
  );
  let created = 0;
  for (const { id } of pending) created += await ingestBatch(deps, orgId, id, now);
  return created;
}

async function ingestBatch(deps: SkillLearningDeps, orgId: string, batchId: string, now: Date): Promise<number> {
  return withTenant(deps.pool, { orgId }, async (tx) => {
    const [batch] = await tx
      .select()
      .from(skillLearningBatches)
      .where(eq(skillLearningBatches.id, batchId))
      .for("update");
    if (batch?.status !== "running" || !batch.runId) return 0;
    const [run] = await tx.select({ state: runs.state }).from(runs).where(eq(runs.id, batch.runId));
    const finish = (status: "done" | "failed", note: string | null, accepted = 0, duplicates = 0) =>
      tx
        .update(skillLearningBatches)
        .set({ status, note, accepted, duplicates, finishedAt: now })
        .where(eq(skillLearningBatches.id, batch.id));
    if (!run) {
      await finish("failed", "Run đề xuất skill không còn.");
      return 0;
    }
    if (!TERMINAL.includes(run.state as (typeof TERMINAL)[number])) return 0;
    const [event] = await tx
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(and(eq(runEvents.runId, batch.runId), eq(runEvents.type, "skill_proposal_report")))
      .orderBy(desc(runEvents.id))
      .limit(1);
    const report = event ? skillProposalSubmitInput.safeParse(event.data) : null;
    if (run.state !== "succeeded" || !report?.success) {
      await finish(
        "failed",
        run.state === "succeeded"
          ? "Agent nộp đề xuất sai dạng."
          : `Run đề xuất skill kết thúc ở trạng thái ${run.state}.`,
      );
      return 0;
    }
    const policy = await loadPolicy(tx);
    const used = await proposalsToday(tx, now);
    let room = policy.skillLearning.enabled ? Math.max(0, policy.skillLearning.maxPerDay - used) : 0;
    const corpus = await skillLearningCorpus(tx, batch.projectId);
    const known = await knownProposals(tx, batch.projectId);
    const dedupe = toDedupe(corpus, known);
    const triggers = [...new Set(Object.values(batch.candidates).flat())];
    const dropped: string[] = [];
    let accepted = 0;
    for (const draft of report.data.proposals.slice(0, SKILL_LEARNING_MAX_PER_RUN)) {
      const why = await screen(tx, batch.projectId, draft, dedupe, room > 0);
      if (typeof why === "string") {
        dropped.push(`${draft.name}: ${why}`);
        continue;
      }
      await tx.insert(learnedSkillProposals).values({
        orgId,
        batchId: batch.id,
        runId: batch.runId,
        teamId: batch.teamId,
        projectId: batch.projectId,
        kind: draft.kind,
        name: draft.name,
        description: draft.description,
        content: draft.content,
        reason: draft.reason,
        scopeTeamId: why.scope.teamId,
        scopeProjectId: why.scope.projectId,
        baseVersion: why.baseVersion,
        triggers,
        sourceRunIds: Object.keys(batch.candidates),
      });
      dedupe.pending.push({ name: draft.name, description: draft.description });
      room--;
      accepted++;
    }
    await finish("done", dropped.length ? clip(dropped.join("; "), 1000) : null, accepted, dropped.length);
    await recordAudit(tx, {
      action: "skill_learning.batch.done",
      actorUserId: null,
      targetType: "skill_learning_batch",
      targetId: batch.id,
      data: { accepted, dropped: dropped.length },
    });
    return accepted;
  });
}

/** Một đề xuất qua được bộ lọc thì trả đích của nó; không thì trả lý do bỏ. */
async function screen(
  tx: Tx,
  projectId: string,
  draft: SkillProposalDraft,
  corpus: DedupeCorpus,
  hasRoom: boolean,
): Promise<string | { scope: { teamId: string | null; projectId: string | null }; baseVersion: number }> {
  if (!hasRoom) return "vượt hạn mức đề xuất của ngày";
  const existing = await findSkillForProject(tx, projectId, draft.name);
  if (draft.kind === "edit") {
    if (!existing) return "không có skill để sửa";
    const current = await currentSkillContent(tx, existing.scope, draft.name);
    if (current !== null && current.trim() === draft.content.trim()) return "nội dung không đổi";
  } else if (existing) {
    return "đã có skill cùng tên";
  }
  const hit = findDuplicate(draft, corpus, { skipExisting: draft.kind === "edit" });
  if (hit) return duplicateReason(hit);
  if (draft.kind === "edit" && existing) return { scope: existing.scope, baseVersion: existing.version };
  const project = await findProject(tx, projectId);
  if (!project) return "dự án không còn";
  return { scope: { teamId: project.teamId, projectId: project.id }, baseVersion: 0 };
}

/**
 * Một lượt của job hẹn giờ cho một tổ chức: nhận kết quả lô đã xong trước, rồi mới lên lô mới, để đề xuất vừa nhận
 * đã được tính vào hạn mức của lô sau.
 */
export async function skillLearningTickForOrg(deps: SkillLearningDeps, orgId: string): Promise<void> {
  await ingestSkillLearning(deps, orgId);
  await planSkillLearning(deps, orgId);
}
