import { eq, sql } from "drizzle-orm";
import { openLearnedSkillPR } from "../knowledge/index.ts";
import { type Jobs, withTenant } from "../platform/index.ts";
import { learnedSkillProposals } from "./schema.ts";
import { type SkillLearningDeps, skillLearningTickForOrg } from "./service.ts";

/**
 * Hẹn giờ 15 phút: nhận kết quả lô đã xong và lên lô mới của ngày. Lô là (dự án, ngày) duy nhất nên chạy dày không tốn
 * thêm token; mỗi lượt chỉ tốn vài truy vấn cho tổ chức có bật tính năng.
 */
export const SKILL_LEARNING_QUEUE = "skill-learning-tick";
export const SKILL_LEARNING_CRON = "*/15 * * * *";
export const skillLearningQueue = {
  name: SKILL_LEARNING_QUEUE,
  // Lịch 15 phút sau chạy lại được, không cần thử lại từng lượt.
  retryLimit: 0,
  expireInSeconds: 10 * 60,
} as const;

/** Mở PR cho đề xuất đã duyệt. Gọi Git nên có hàng đợi riêng để thử lại khi Git bận. */
export const SKILL_LEARNING_PR_QUEUE = "skill-learning-pr";
export const skillLearningPrQueue = {
  name: SKILL_LEARNING_PR_QUEUE,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
  policy: "stately",
} as const;

export interface SkillLearningPrJob {
  orgId: string;
  proposalId: string;
}

/** Tổ chức bật tính năng hoặc còn lô đang chạy; hàm SECURITY DEFINER vì job hẹn giờ chạy không có tổ chức trong context. */
async function activeOrgs(deps: SkillLearningDeps): Promise<string[]> {
  return withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.skill_learning_orgs()`);
    return rows.map((r) => r.org_id);
  });
}

/** Một lượt hẹn giờ cho mọi tổ chức; lỗi của một tổ chức không chặn tổ chức khác. */
export async function runSkillLearningTick(deps: SkillLearningDeps): Promise<number> {
  const orgs = await activeOrgs(deps);
  for (const orgId of orgs) {
    try {
      await skillLearningTickForOrg(deps, orgId);
    } catch (e) {
      deps.logger?.error(`Học skill lỗi ở tổ chức ${orgId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return orgs.length;
}

/**
 * Mở PR vào kho skill cho đề xuất đã duyệt (mode `pr`). Chạy lại an toàn: đã có số PR thì thôi. Lỗi ghi vào đề xuất để
 * người duyệt thấy, rồi ném lại cho pg-boss thử lại.
 */
export async function deliverLearnedProposal(
  deps: SkillLearningDeps,
  orgId: string,
  proposalId: string,
): Promise<void> {
  const row = await withTenant(deps.pool, { orgId }, async (tx) => {
    const [p] = await tx.select().from(learnedSkillProposals).where(eq(learnedSkillProposals.id, proposalId));
    return p?.status === "approved" && p.deliveryMode === "pr" && p.prNumber === null ? p : null;
  });
  if (!row) return;
  try {
    const pr = await openLearnedSkillPR(deps, orgId, {
      proposalId,
      scope: { teamId: row.scopeTeamId, projectId: row.scopeProjectId },
      name: row.name,
      description: row.description,
      content: row.content,
      kind: row.kind as "new" | "edit",
      reason: row.reason,
    });
    await withTenant(deps.pool, { orgId }, (tx) =>
      tx
        .update(learnedSkillProposals)
        .set({ prNumber: pr.number, prUrl: pr.url, deliveryError: null })
        .where(eq(learnedSkillProposals.id, proposalId)),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withTenant(deps.pool, { orgId }, (tx) =>
      tx
        .update(learnedSkillProposals)
        .set({ deliveryError: message.slice(0, 500) })
        .where(eq(learnedSkillProposals.id, proposalId)),
    );
    throw e;
  }
}

export async function registerSkillLearningWorker(jobs: Jobs, deps: SkillLearningDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work(SKILL_LEARNING_QUEUE, async () => void (await runSkillLearningTick(full)));
  await jobs.schedule(SKILL_LEARNING_QUEUE, SKILL_LEARNING_CRON);
  await jobs.work<SkillLearningPrJob>(SKILL_LEARNING_PR_QUEUE, ({ data }) =>
    deliverLearnedProposal(full, data.orgId, data.proposalId),
  );
}
