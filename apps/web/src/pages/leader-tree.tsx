import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DelegationTree, treeRefetchMs } from "@xdev-hive/ui/delegation-tree";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";

/**
 * Tab "Cây giao việc" của một cuộc trò chuyện với Leader (specs/028 US1, US2). Cây do hub dựng sẵn (R5); trang chỉ
 * hỏi lại theo nhịp và mở trang run khi bấm, terminal và log vẫn ở trang run như cũ.
 */
export function LeaderTree({ threadId }: { threadId: string }) {
  const { api } = useOrg();
  const navigate = useNavigate();
  const tree = useQuery({
    ...api.leader.tree.get.queryOptions({ input: { id: threadId } }),
    refetchInterval: (query) => treeRefetchMs(query.state.data),
  });
  // Đồng hồ chỉ chạy khi còn run đang chạy, để thời gian trên nút tăng giữa hai lần hỏi hub.
  const now = useNow(1000, !!tree.data?.active);

  if (tree.isPending) return <LoadingState />;
  if (tree.isError) return <LoadFailure error={tree.error} retry={tree.refetch} />;
  return (
    <section aria-label="Cây giao việc" className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
      <DelegationTree
        tree={tree.data}
        now={now}
        onOpenRun={(run) => void navigate({ to: "/runs/$id", params: { id: run.id } })}
      />
    </section>
  );
}
