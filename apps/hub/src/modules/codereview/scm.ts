import type { Tx } from "../platform/index.ts";
import type { ScmEventRegistry } from "../scm/index.ts";
import { type EndedDeps, onPullRequestEnded } from "./merge.ts";
import { openNextRound, openReviewOnBranch } from "./routing.ts";
import { type CodeReviewDeps, type CodeReviewRow, scheduleAdvance } from "./service.ts";

export interface BranchPushed {
  projectId: string;
  branch: string;
  headSha: string;
}

/**
 * Commit mới trên nhánh PR ngoài run của Hive (Edge Cases, FR-026): phiên đang mở ở commit khác thành `superseded` và vòng
 * mới mở với `head_sha` mới, giữ run của vòng trước. Bằng chứng của run đó gắn với commit cũ nên checkpoint lệnh chờ
 * người xem (FR-017). Bỏ qua khi phiên đang chờ run sửa của agent: run đó đẩy commit rồi tự mở vòng mới kèm kết quả
 * lệnh, còn webhook của chính lần đẩy đó tới trước hay sau đều không được tranh mở vòng thiếu bằng chứng. Webhook giao
 * lại cùng SHA thì không làm gì.
 */
export async function onBranchPushed(tx: Tx, input: BranchPushed, deps: CodeReviewDeps): Promise<CodeReviewRow | null> {
  const open = await openReviewOnBranch(tx, input.projectId, input.branch);
  if (!open || open.headSha === input.headSha) return null;
  if (open.status === "changes_requested" && open.route === "agent") return null;
  const row = await openNextRound(
    tx,
    open,
    { runId: open.runId, headSha: input.headSha, ownerUserId: null, stats: null, reasons: [], source: "push" },
    deps,
  );
  await scheduleAdvance(tx, row, deps);
  return row;
}

/**
 * Đăng ký handler webhook của `codereview` (main.ts gọi lúc khởi động vai trò `jobs`): push mở vòng mới, PR merge hay
 * đóng kết thúc phiên (FR-029). Trả hàm huỷ đăng ký.
 */
export function registerCodeReviewScm(registry: ScmEventRegistry, deps: CodeReviewDeps & EndedDeps): () => void {
  const off = [
    registry.on("push", async (event, ctx) => {
      await onBranchPushed(ctx.tx, { projectId: ctx.projectId, branch: event.branch, headSha: event.sha }, deps);
    }),
    registry.on("pull_request.merged", async (event, ctx) => {
      await onPullRequestEnded(
        ctx.tx,
        { projectId: ctx.projectId, prNumber: event.pullRequest.number, outcome: "merged" },
        deps,
      );
    }),
    registry.on("pull_request.closed", async (event, ctx) => {
      await onPullRequestEnded(
        ctx.tx,
        { projectId: ctx.projectId, prNumber: event.pullRequest.number, outcome: "closed" },
        deps,
      );
    }),
  ];
  return () => {
    for (const f of off) f();
  };
}
