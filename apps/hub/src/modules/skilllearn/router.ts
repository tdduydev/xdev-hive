import { implement } from "@orpc/server";
import { contract, type LearnedSkillProposal } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type { Jobs, RequestContext, Tx } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { SKILL_LEARNING_PR_QUEUE, type SkillLearningPrJob } from "./jobs.ts";
import {
  approveLearnedProposal,
  listLearnedProposals,
  markRunForLearning,
  rejectLearnedProposal,
  skillLearningStats,
} from "./proposals.ts";
import { learnedSkillProposals } from "./schema.ts";

/** Hub không có hàng đợi (thiếu HIVE_DATABASE_JOBS_URL) thì không mở được PR: ghi lý do để người duyệt thấy. */
async function markNoQueue(tx: Tx, proposal: LearnedSkillProposal): Promise<LearnedSkillProposal> {
  const error = "Hub chưa cấu hình hàng đợi (HIVE_DATABASE_JOBS_URL) nên chưa mở được PR vào kho skill.";
  await tx.update(learnedSkillProposals).set({ deliveryError: error }).where(eq(learnedSkillProposals.id, proposal.id));
  return proposal.delivery ? { ...proposal, delivery: { ...proposal.delivery, error } } : proposal;
}

/** Tab “Đề xuất từ agent” của trang Skills (specs/014). Quyền kiểm trong từng hàm của proposals.ts. */
export function skillLearningRouter(deps: OrgDeps & { jobs?: Jobs | undefined }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const api = implement(contract.skillLearning).$context<RequestContext>().use(authed).use(inOrg);
  return {
    skillLearning: {
      list: api.list.handler(({ context: { tx, user }, input }) => listLearnedProposals(tx, user.id, input)),
      stats: api.stats.handler(({ context: { tx, user }, input }) => skillLearningStats(tx, user.id, input)),
      approve: api.approve.handler(async ({ context: { tx, user, orgId }, input }) => {
        const { proposal, openPr } = await approveLearnedProposal(tx, user.id, input);
        // Xếp việc mở PR cùng transaction để duyệt và việc mở PR cùng commit hoặc cùng rollback.
        if (!openPr) return proposal;
        if (!deps.jobs) return markNoQueue(tx, proposal);
        await deps.jobs.enqueue<SkillLearningPrJob>(
          SKILL_LEARNING_PR_QUEUE,
          { orgId, proposalId: proposal.id },
          { tx, singletonKey: proposal.id },
        );
        return proposal;
      }),
      reject: api.reject.handler(({ context: { tx, user }, input }) => rejectLearnedProposal(tx, user.id, input)),
      mark: api.mark.handler(({ context: { tx, user }, input }) => markRunForLearning(tx, user.id, input)),
    },
  };
}
