import type { ChatAction } from "@xdev-hive/contracts";
import { decideReview } from "../knowledge/index.ts";
import { approveApproval, rejectApproval } from "../leader/index.ts";
import { ConflictError, type Tx } from "../platform/index.ts";
import type { ChatDeps } from "./deps.ts";

export interface ActionResult {
  text: string;
  /** Việc phải làm sau khi transaction commit (giao run đi). */
  after?: (() => void) | undefined;
}

const NO_REASON = "Trả lại qua chat (không ghi lý do).";

function needRuns(deps: ChatDeps) {
  if (!deps.runs) throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình giao run.");
  return deps.runs;
}

/**
 * Chạy một hành động của nút trong transaction của người đã liên kết. Đi qua đúng hàm mà web gọi, nên kiểm vai trò và
 * trạng thái hệt như web; nút không có quyền riêng.
 */
export async function performAction(deps: ChatDeps, tx: Tx, userId: string, action: ChatAction): Promise<ActionResult> {
  switch (action.kind) {
    case "approval.approve": {
      const { afterCommit } = await approveApproval(deps.runs, tx, userId, action.approvalId);
      return { text: "Đã duyệt và thực hiện đề xuất.", after: afterCommit };
    }
    case "approval.reject": {
      await rejectApproval(tx, userId, action.approvalId, NO_REASON);
      return { text: "Đã từ chối đề xuất." };
    }
    case "plan.approve": {
      const { afterCommit } = await needRuns(deps).planActions.approve(tx, userId, {
        id: action.taskId,
        planId: action.planId,
      });
      return { text: "Đã duyệt kế hoạch, agent sẽ chạy tiếp.", after: afterCommit };
    }
    case "plan.reject": {
      const { afterCommit } = await needRuns(deps).planActions.reject(tx, userId, {
        id: action.taskId,
        planId: action.planId,
        reason: NO_REASON,
        replan: false,
      });
      return { text: "Đã trả lại kế hoạch; task về trạng thái chưa làm.", after: afterCommit };
    }
    case "review.approve": {
      const detail = await decideReview(
        tx,
        userId,
        { id: action.reviewId, decision: "approve" },
        { jobs: deps.jobs, publicUrl: deps.publicUrl },
      );
      return { text: `Đã duyệt checkpoint (${detail.status}).` };
    }
    case "review.changes": {
      await decideReview(
        tx,
        userId,
        { id: action.reviewId, decision: "changes", note: NO_REASON },
        { jobs: deps.jobs, publicUrl: deps.publicUrl },
      );
      return { text: "Đã trả lại tài liệu cho người viết." };
    }
    case "run.cancel": {
      const { afterCommit } = await needRuns(deps).cancelRun(tx, userId, action.runId);
      return { text: "Đã huỷ run.", after: afterCommit };
    }
  }
}
