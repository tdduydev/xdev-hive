import { loadProject } from "../catalog/index.ts";
import type { MasterKey, Tx } from "../platform/index.ts";
import {
  type CommitStatusInput,
  type GitProvider,
  loadConnection,
  type ProviderFactory,
  type RepoRef,
} from "../scm/index.ts";
import type { codeReviews } from "./schema.ts";

type ReviewRow = typeof codeReviews.$inferSelect;

/** Tên kiểm tra hiện trên PR; bảo vệ nhánh của dự án chọn đúng chuỗi này (Q1, trang cài đặt dự án gợi ý). */
export const REVIEW_STATUS_CONTEXT = "xdev-hive/review";

export interface ReviewStatusDeps {
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | undefined;
  /** Địa chỉ web để `targetUrl` dẫn về phiên review. */
  publicUrl?: string | undefined;
  logger?: Pick<Console, "warn"> | undefined;
}

/** GitHub cắt mô tả ở 140 ký tự; tự cắt để chữ không đứt giữa từ ngoài ý muốn. */
const DESCRIPTION_MAX = 140;
const clip = (s: string) => (s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX - 1)}…` : s);

const reviewLink = (publicUrl: string | undefined, id: string) =>
  publicUrl ? `${publicUrl.replace(/\/+$/, "")}/knowledge/reviews?tab=code&id=${id}` : undefined;

/**
 * Status của phiên trên commit đầu của PR (Q1). `in_review` là `pending`, `changes_requested` là `failure` để bảo vệ
 * nhánh vẫn chặn merge khi agent hay tác giả đang sửa, `approved` mới là `success`. Phiên `cancelled` (người huỷ) thả
 * PR ra bằng `success` vì Hive không còn giữ cổng, giống hàng merge không chặn PR không có phiên mở (FR-030); status
 * `pending` còn sót sẽ treo PR mãi. `merged` và `superseded` không đăng: PR đã xong, hoặc vòng mới tự đăng trên SHA mới.
 */
export function reviewStatusOf(review: ReviewRow, publicUrl?: string): CommitStatusInput | null {
  const targetUrl = reviewLink(publicUrl, review.id);
  const base = (state: CommitStatusInput["state"], description: string): CommitStatusInput => ({
    context: REVIEW_STATUS_CONTEXT,
    state,
    description: clip(description),
    ...(targetUrl ? { targetUrl } : {}),
  });
  switch (review.status) {
    case "in_review":
      return base("pending", `Đang review code theo quy trình ${review.workflowName}`);
    case "changes_requested":
      return base("failure", `Cần sửa trước khi duyệt (quy trình ${review.workflowName})`);
    case "approved":
      return base("success", `Đã duyệt theo quy trình ${review.workflowName}`);
    case "cancelled":
      return base("success", "Phiên review đã huỷ, Hive không còn chặn PR này");
    default:
      return null;
  }
}

export interface ReviewStatusDelivery {
  provider: GitProvider;
  ref: RepoRef;
  sha: string;
  input: CommitStatusInput;
  prNumber: number;
}

/**
 * Bước đọc trong transaction: kết nối Git của dự án và nội dung status. Tách khỏi lời gọi mạng để người gọi không giữ
 * transaction chờ nhà cung cấp; null khi phiên ở trạng thái không đăng, hoặc hub chưa có khoá chủ/nhà cung cấp.
 */
export async function prepareReviewStatus(
  tx: Tx,
  review: ReviewRow,
  deps: ReviewStatusDeps,
): Promise<ReviewStatusDelivery | null> {
  const input = reviewStatusOf(review, deps.publicUrl);
  if (!input || !deps.providerFactory || !deps.masterKey) return null;
  const project = await loadProject(tx, review.projectId);
  const conn = project && (await loadConnection(tx, deps.masterKey, project.scmConnectionId));
  if (!project || !conn) {
    (deps.logger ?? console).warn(
      `Không đặt được status ${REVIEW_STATUS_CONTEXT} cho PR #${review.prNumber}: thiếu dự án hoặc kết nối Git.`,
    );
    return null;
  }
  return {
    provider: deps.providerFactory(conn),
    ref: { owner: project.repoOwner, name: project.repoName },
    sha: review.headSha,
    input,
    prNumber: review.prNumber,
  };
}

/**
 * Bước mạng. Không ném lỗi: kết quả review đã nằm trên hub, status chỉ là bản sao cho bảo vệ nhánh của nhà cung cấp, và
 * lần đổi trạng thái kế tiếp đặt lại. Idempotent, đặt cùng trạng thái hai lần không đổi gì.
 */
export async function deliverReviewStatus(
  delivery: ReviewStatusDelivery,
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  try {
    await delivery.provider.setCommitStatus(delivery.ref, delivery.sha, delivery.input);
  } catch (e) {
    logger.warn(
      `Không đặt được status ${REVIEW_STATUS_CONTEXT} cho PR #${delivery.prNumber}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Đặt status theo trạng thái hiện tại của phiên. Chỉ phần đọc nằm trong transaction của người gọi; lời gọi mạng chạy
 * tiếp ở nền (như bình luận của `ai.ts`) để không giữ transaction chờ nhà cung cấp. Cần chờ kết quả (test) thì gọi
 * `prepareReviewStatus` rồi `deliverReviewStatus`.
 */
export async function publishReviewStatus(tx: Tx, review: ReviewRow, deps: ReviewStatusDeps): Promise<void> {
  const delivery = await prepareReviewStatus(tx, review, deps);
  if (delivery) void deliverReviewStatus(delivery, deps.logger);
}
