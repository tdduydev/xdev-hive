import { useQuery } from "@tanstack/react-query";
import type { CodeReviewStatus, CodeReviewSummary } from "@xdev-hive/contracts";
import { useOrgs } from "@/shell/org-context.ts";

export type ReviewsTab = "docs" | "code";

/** Trạng thái lọc ở hàng chờ code: phiên đã `superseded` hoặc `merged` không còn việc cho người duyệt nên không liệt kê. */
export const CODE_STATUSES: CodeReviewStatus[] = ["in_review", "changes_requested", "approved", "cancelled"];

/** Số hiện trên tab và menu: quá 99 thì rút gọn để chip không giãn ra. */
export function countLabel(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Gộp các trang của danh sách phân trang theo `id`: phiên đổi trang giữa hai lần tải có thể xuất hiện hai lần. */
export function uniqueById<T extends { id: string }>(pages: readonly (readonly T[])[]): T[] {
  return [...new Map(pages.flat().map((row) => [row.id, row])).values()];
}

/** Số phiên đang chờ chính người dùng (danh sách `scope: "mine"` có thể gồm cả phiên đã qua checkpoint của họ). */
export function awaitingCount(items: readonly Pick<CodeReviewSummary, "awaitingMe">[]): number {
  return items.filter((i) => i.awaitingMe).length;
}

/** Khoá cache của số PR chờ tôi, để nơi quyết định xong làm mới được badge ở menu. */
export const codeReviewCountKey = (orgId: string) => ["org", orgId, "codeReviews", "count"] as const;

/** Số PR chờ tôi duyệt, cho badge ở menu. Lỗi (hub cũ chưa có route, thiếu quyền) thì không hiện badge. */
export function useAwaitingCodeReviews(): number {
  const { current } = useOrgs();
  const count = useQuery({
    queryKey: codeReviewCountKey(current?.org.id ?? "none"),
    queryFn: () => (current ? current.api.codeReviews.count.call({}) : Promise.resolve({ awaitingMe: 0 })),
    enabled: !!current,
    refetchInterval: 60_000,
    retry: false,
  });
  return count.data?.awaitingMe ?? 0;
}
