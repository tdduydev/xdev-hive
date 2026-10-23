import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { formatDayTime } from "@/lib/format.ts";
import { useOrg } from "@/shell/org-context.ts";

const VI = {
  title: "Commit thay đổi",
  loading: "Đang tải commit thay đổi",
  noPrevious: "Chưa có bản triển khai thành công trước đó để so sánh.",
  empty: "Không có commit để hiển thị.",
  incomplete: "Danh sách bị cắt bớt hoặc chưa lấy đủ từ nguồn Git.",
  from: "Từ bản",
  to: "Đến bản",
  unknown: "Không rõ",
};

export function DeployCompare({ deployId }: { deployId: string }) {
  const { api } = useOrg();
  const headingId = useId();
  const query = useQuery(api.deploys.approvals.compare.queryOptions({ input: { id: deployId } }));
  const data = query.data;
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-2.5">
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        {VI.title}
      </h3>
      {query.isPending ? (
        <TableSkeleton label={VI.loading} rows={2} columns={2} />
      ) : query.isError ? (
        <LoadFailure error={query.error} retry={query.refetch} />
      ) : (
        data && (
          <>
            <p className="text-xs break-words text-muted-foreground">
              {VI.from}:{" "}
              <span className="font-mono">
                {data.from ? data.from.commit || data.from.revision || data.from.tag || VI.unknown : "—"}
              </span>
              {" → "}
              {VI.to}:{" "}
              <span className="font-mono">{data.to.commit || data.to.revision || data.to.tag || VI.unknown}</span>
            </p>
            {!data.from ? (
              <p className="text-sm text-muted-foreground">{VI.noPrevious}</p>
            ) : (
              data.commits.length === 0 && <p className="text-sm text-muted-foreground">{VI.empty}</p>
            )}
            {data.commits.length > 0 && (
              <ul aria-label={VI.title} className="grid divide-y divide-border">
                {data.commits.map((commit) => (
                  <li key={commit.sha} className="grid min-w-0 gap-1 py-2 text-sm">
                    <p className="break-words text-foreground">
                      <span title={commit.sha} className="font-mono text-xs">
                        {commit.sha.slice(0, 7)}
                      </span>
                      {" · "}
                      {commit.title}
                    </p>
                    <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs break-words text-muted-foreground">
                      <span>{commit.author}</span>
                      <time dateTime={commit.at}>{formatDayTime(commit.at)}</time>
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {data.incomplete && (
              <p role="status" className="text-sm text-warning">
                {VI.incomplete}
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}
