import {
  type LearnedProposalApproveInput,
  type LearnedProposalListInput,
  type LearnedProposalRejectInput,
  type LearnedSkillProposal,
  type LearnMarkInput,
  type LearnTrigger,
  learnedProposalApproveInput,
  learnedProposalListInput,
  learnedProposalRejectInput,
  learnMarkInput,
  type SkillLearningStats,
  skillLearningStatsInput,
} from "@xdev-hive/contracts";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { findProject } from "../catalog/index.ts";
import { loadPolicy } from "../governance/index.ts";
import {
  applyLearnedSkill,
  assertCanManageScope,
  hasSkillRepo,
  type Scope,
  skillVersionIn,
} from "../knowledge/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { orgRoleOf, requireTeamRole, teamRolesOf } from "../tenancy/index.ts";
import { learnedSkillProposals, skillLearningBatches, skillLearningMarks } from "./schema.ts";
import { proposalsToday } from "./service.ts";

type Row = typeof learnedSkillProposals.$inferSelect;

const notFound = () => new NotFoundError("LEARNED_PROPOSAL_NOT_FOUND", "Không tìm thấy đề xuất skill.");

/** Tên dự án theo id, tra một lần cho cả danh sách. */
async function projectKeys(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(ids)) out.set(id, (await findProject(tx, id))?.key ?? "");
  return out;
}

function view(r: Row, projectKey: string): LearnedSkillProposal {
  const level = r.scopeProjectId ? "project" : r.scopeTeamId ? "team" : "org";
  return {
    id: r.id,
    kind: r.kind as "new" | "edit",
    name: r.name,
    description: r.description,
    content: r.content,
    reason: r.reason,
    status: r.status as LearnedSkillProposal["status"],
    projectId: r.projectId,
    projectKey,
    scope: { level, teamId: r.scopeTeamId, projectId: r.scopeProjectId },
    baseVersion: r.baseVersion,
    triggers: r.triggers as LearnTrigger[],
    sourceRunIds: r.sourceRunIds,
    runId: r.runId,
    createdAt: r.createdAt.toISOString(),
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    delivery: r.deliveryMode
      ? {
          mode: r.deliveryMode as "pr" | "saved",
          prNumber: r.prNumber,
          prUrl: r.prUrl,
          error: r.deliveryError,
          skillId: r.resultSkillId,
          version: r.resultVersion,
        }
      : null,
  };
}

/** Đề xuất của các đội người gọi là thành viên, mới nhất trước. */
export async function listLearnedProposals(
  tx: Tx,
  userId: string,
  input: LearnedProposalListInput,
): Promise<LearnedSkillProposal[]> {
  const data = learnedProposalListInput.parse(input);
  const teams = [...(await teamRolesOf(tx, userId)).keys()];
  if (!teams.length) return [];
  const project = data.project ? await findProject(tx, data.project) : null;
  if (data.project && !project) return [];
  const rows = await tx
    .select()
    .from(learnedSkillProposals)
    .where(
      and(
        inArray(learnedSkillProposals.teamId, teams),
        data.status ? eq(learnedSkillProposals.status, data.status) : undefined,
        project ? eq(learnedSkillProposals.projectId, project.id) : undefined,
      ),
    )
    .orderBy(desc(learnedSkillProposals.createdAt), desc(learnedSkillProposals.id))
    .limit(data.limit)
    .offset(data.offset);
  const keys = await projectKeys(
    tx,
    rows.map((r) => r.projectId),
  );
  return rows.map((r) => view(r, keys.get(r.projectId) ?? ""));
}

/** Đề xuất đang chờ, khoá dòng để hai người duyệt cùng lúc không tạo hai PR hay hai phiên bản. */
async function decidable(tx: Tx, userId: string, id: string): Promise<Row> {
  const [row] = await tx.select().from(learnedSkillProposals).where(eq(learnedSkillProposals.id, id)).for("update");
  if (!row) throw notFound();
  if (!(await teamRolesOf(tx, userId, [row.teamId])).has(row.teamId)) throw notFound();
  await requireTeamRole(tx, userId, row.teamId, "admin");
  if (row.status !== "pending")
    throw new ConflictError(
      "LEARNED_PROPOSAL_DECIDED",
      row.status === "approved" ? "Đề xuất đã được duyệt." : "Đề xuất đã bị từ chối.",
    );
  return row;
}

export interface Approved {
  proposal: LearnedSkillProposal;
  /** Có PR cần mở thì job nền (hoặc người gọi, khi hub không có hàng đợi) làm sau khi commit. */
  openPr: boolean;
}

/**
 * Duyệt (specs/014 FR-004). Đã nối kho skill Git: ghi đề xuất là đã duyệt và xếp việc mở PR, vì gọi Git không nên
 * nằm trong transaction. Chưa nối kho: lưu thẳng thành skill của tổ chức, như duyệt đề xuất sửa skill thường.
 * `edit` giữ phạm vi của skill đang sửa; `new` mặc định ở dự án nguồn, người duyệt có thể nâng lên đội hay tổ chức.
 */
export async function approveLearnedProposal(
  tx: Tx,
  userId: string,
  input: LearnedProposalApproveInput,
): Promise<Approved> {
  const data = learnedProposalApproveInput.parse(input);
  const row = await decidable(tx, userId, data.id);
  const scope = targetScope(row, data.scope);
  await assertCanManageScope(tx, userId, scope);
  const repo = await hasSkillRepo(tx);
  const current = await skillVersionIn(tx, scope, row.name);
  // Skill đổi sau khi agent đề xuất thì không ghi đè: người duyệt từ chối hoặc chờ lô sau đề xuất lại trên bản mới.
  if (current !== row.baseVersion)
    throw new ConflictError(
      "VERSION_CONFLICT",
      current === 0 && row.kind === "edit"
        ? "Skill đã bị xoá sau khi agent đề xuất."
        : `Skill ${row.name} đã ở phiên bản ${current}, đề xuất dựa trên phiên bản ${row.baseVersion}. Hãy từ chối để agent đề xuất lại trên bản mới.`,
    );
  const base = {
    status: "approved",
    decidedBy: userId,
    decidedAt: new Date(),
    decisionNote: data.note ?? null,
    scopeTeamId: scope.teamId,
    scopeProjectId: scope.projectId,
  };
  let patch: Partial<Row>;
  if (repo) {
    patch = { ...base, deliveryMode: "pr" };
  } else {
    const saved = await applyLearnedSkill(
      tx,
      userId,
      scope,
      {
        name: row.name,
        description: row.description,
        content: row.content,
        baseVersion: row.baseVersion,
        message: data.note ?? row.reason,
      },
      row.id,
    );
    patch = { ...base, deliveryMode: "saved", resultSkillId: saved.skillId, resultVersion: saved.version };
  }
  const [updated] = await tx
    .update(learnedSkillProposals)
    .set(patch)
    .where(eq(learnedSkillProposals.id, row.id))
    .returning();
  if (!updated) throw notFound();
  await recordAudit(tx, {
    action: "skill_learning.approve",
    targetType: "learned_skill_proposal",
    targetId: row.id,
    data: { name: row.name, kind: row.kind, mode: patch.deliveryMode },
  });
  const keys = await projectKeys(tx, [row.projectId]);
  return { proposal: view(updated, keys.get(row.projectId) ?? ""), openPr: repo };
}

function targetScope(row: Row, level: "org" | "team" | "project" | undefined): Scope {
  if (row.kind === "edit") return { teamId: row.scopeTeamId, projectId: row.scopeProjectId };
  if (level === "org") return { teamId: null, projectId: null };
  if (level === "team") return { teamId: row.teamId, projectId: null };
  return { teamId: row.teamId, projectId: row.projectId };
}

/** Từ chối kèm lý do; dòng được giữ để lô sau không đề xuất lại (dedupe.ts so với các đề xuất `rejected`). */
export async function rejectLearnedProposal(
  tx: Tx,
  userId: string,
  input: LearnedProposalRejectInput,
): Promise<LearnedSkillProposal> {
  const data = learnedProposalRejectInput.parse(input);
  const row = await decidable(tx, userId, data.id);
  const [updated] = await tx
    .update(learnedSkillProposals)
    .set({ status: "rejected", decidedBy: userId, decidedAt: new Date(), decisionNote: data.reason })
    .where(eq(learnedSkillProposals.id, row.id))
    .returning();
  if (!updated) throw notFound();
  await recordAudit(tx, {
    action: "skill_learning.reject",
    targetType: "learned_skill_proposal",
    targetId: row.id,
    data: { name: row.name, reason: data.reason },
  });
  const keys = await projectKeys(tx, [row.projectId]);
  return view(updated, keys.get(row.projectId) ?? "");
}

/** Đánh dấu hay bỏ đánh dấu một run code “nên thành skill”; thành viên đội của run. */
export async function markRunForLearning(
  tx: Tx,
  userId: string,
  input: LearnMarkInput,
): Promise<{ runId: string; marked: boolean }> {
  const data = learnMarkInput.parse(input);
  const [run] = await tx.select({ teamId: runs.teamId, kind: runs.kind }).from(runs).where(eq(runs.id, data.runId));
  if (!run || !(await teamRolesOf(tx, userId, [run.teamId])).has(run.teamId))
    throw new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run trong tổ chức.");
  await requireTeamRole(tx, userId, run.teamId, "member");
  if (run.kind !== "code")
    throw new ConflictError("RUN_NOT_LEARNABLE", "Chỉ đánh dấu được run code: run khác không có cách sửa để học.");
  if (!data.marked) {
    await tx.delete(skillLearningMarks).where(eq(skillLearningMarks.runId, data.runId));
    return { runId: data.runId, marked: false };
  }
  await tx
    .insert(skillLearningMarks)
    .values({ orgId: sql`hive.ctx_org()`, runId: data.runId, markedBy: userId, note: data.note ?? null })
    .onConflictDoUpdate({ target: skillLearningMarks.runId, set: { note: data.note ?? null } });
  await recordAudit(tx, {
    action: "skill_learning.mark",
    targetType: "run",
    targetId: data.runId,
  });
  return { runId: data.runId, marked: true };
}

/** Số đề xuất, tỉ lệ duyệt và chi phí token của việc học trong `days` ngày gần nhất. */
export async function skillLearningStats(
  tx: Tx,
  userId: string,
  input: { days?: number | undefined },
  now: Date = new Date(),
): Promise<SkillLearningStats> {
  const { days } = skillLearningStatsInput.parse(input);
  if (!(await orgRoleOf(tx, userId)))
    throw new ForbiddenError("NOT_ORG_MEMBER", "Bạn không phải thành viên của tổ chức này.");
  const since = new Date(now.getTime() - days * 86_400_000);
  const policy = await loadPolicy(tx);
  const byStatus = await tx
    .select({ status: learnedSkillProposals.status, n: count() })
    .from(learnedSkillProposals)
    .where(gte(learnedSkillProposals.createdAt, since))
    .groupBy(learnedSkillProposals.status);
  const n = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
  const batches = await tx
    .select({
      candidates: skillLearningBatches.candidates,
      duplicates: skillLearningBatches.duplicates,
      status: skillLearningBatches.status,
    })
    .from(skillLearningBatches)
    .where(gte(skillLearningBatches.createdAt, since));
  const [cost] = await tx
    .select({
      usd: sql<string | null>`sum(${runs.costUsd})`,
      tokens: sql<string>`coalesce(sum(${runs.tokensIn} + ${runs.tokensOut}), 0)`,
    })
    .from(runs)
    .where(and(eq(runs.kind, "skill_proposal"), gte(runs.createdAt, since)));
  const decided = n("approved") + n("rejected");
  return {
    enabled: policy.skillLearning.enabled,
    days,
    batches: batches.filter((b) => b.status !== "empty").length,
    candidateRuns: batches.reduce((sum, b) => sum + Object.keys(b.candidates).length, 0),
    proposals: n("pending") + decided,
    pending: n("pending"),
    approved: n("approved"),
    rejected: n("rejected"),
    duplicates: batches.reduce((sum, b) => sum + b.duplicates, 0),
    approvalRate: decided ? n("approved") / decided : null,
    costUsd: cost?.usd == null ? null : Number(cost.usd),
    tokens: Number(cost?.tokens ?? 0),
    today: { used: await proposalsToday(tx, now), limit: policy.skillLearning.maxPerDay },
  };
}
