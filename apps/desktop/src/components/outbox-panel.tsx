import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { useEffect } from "react";
import { queryClient } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  OUTBOX_KEY,
  OUTBOX_REFRESH_MS,
  type OutboxState,
  onOutboxChanged,
  outboxDrop,
  outboxExport,
  outboxRetry,
  outboxStatus,
} from "@/lib/outbox.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  empty: string;
  loading: string;
  refresh: string;
  offline: (n: number) => string;
  drop: string;
  retry: string;
  export: string;
  exported: (path: string) => string;
  noReason: string;
  rejectedHint: string;
  states: Record<OutboxState, string>;
  heldReasons: Record<string, string>;
}> = {
  vi: {
    title: "Hộp thư đi",
    lead: "Worker giữ các mục trên máy và gửi khi hub kết nối lại.",
    empty: "Không có mục nào trong hộp thư đi.",
    loading: "Đang tải…",
    refresh: "Làm mới",
    offline: (n) => `Hub đang vắng – ${n} mục chờ gửi`,
    drop: "Bỏ",
    retry: "Gửi lại",
    export: "Xuất",
    exported: (path) => `Đã xuất ra ${path}`,
    noReason: "Hub chưa nêu lý do.",
    rejectedHint: "Xuất nội dung rồi sửa và tạo đề xuất mới; hub đã chốt kết quả cho khoá này.",
    states: {
      pending: "Chờ gửi",
      sending: "Đang gửi",
      held: "Đang giữ",
      rejected: "Bị từ chối",
      expired: "Hết hạn",
      accepted: "Đã nhận",
      duplicate: "Đã nhận trước đó",
    },
    heldReasons: { login_required: "Cần đăng nhập lại.", identity_mismatch: "Máy đang đăng nhập người khác." },
  },
  en: {
    title: "Outbox",
    lead: "The worker keeps items on this machine and sends them when the hub reconnects.",
    empty: "The outbox is empty.",
    loading: "Loading…",
    refresh: "Refresh",
    offline: (n) => `Hub unavailable – ${n} items waiting to send`,
    drop: "Drop",
    retry: "Retry",
    export: "Export",
    exported: (path) => `Exported to ${path}`,
    noReason: "The hub gave no reason.",
    rejectedHint: "Export, edit and create a new proposal; the hub has finalized this key's result.",
    states: {
      pending: "Pending",
      sending: "Sending",
      held: "Held",
      rejected: "Rejected",
      expired: "Expired",
      accepted: "Accepted",
      duplicate: "Duplicate",
    },
    heldReasons: { login_required: "Sign in again.", identity_mismatch: "Another user is signed in on this machine." },
  },
};

function useOutbox() {
  const qc = useQueryClient();
  useEffect(() => onOutboxChanged(() => void qc.invalidateQueries({ queryKey: OUTBOX_KEY })), [qc]);
  return useQuery({ queryKey: OUTBOX_KEY, queryFn: outboxStatus, refetchInterval: OUTBOX_REFRESH_MS });
}

export function OutboxBanner() {
  return (
    <QueryClientProvider client={queryClient}>
      <Banner />
    </QueryClientProvider>
  );
}
function Banner() {
  const t = useT(text);
  const { data } = useOutbox();
  if (!data || !["down", "retrying"].includes(data.hub)) return null;
  return (
    <div role="status" className="border-b bg-warning-soft px-5 py-2 text-sm text-warning">
      <a href="#/outbox" className="underline underline-offset-2">
        {t.offline(data.pending)}
      </a>
    </div>
  );
}

export function OutboxPanel() {
  return (
    <QueryClientProvider client={queryClient}>
      <Panel />
    </QueryClientProvider>
  );
}
function Panel() {
  const t = useT(text);
  const qc = useQueryClient();
  const status = useOutbox();
  const action = useMutation({
    mutationFn: async ({ kind, key }: { kind: "drop" | "retry" | "export"; key: string }) => {
      if (kind === "export") return outboxExport(key);
      if (kind === "drop") await outboxDrop(key);
      else await outboxRetry(key);
      return null;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OUTBOX_KEY }),
  });
  return (
    <section aria-label={t.title} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t.lead}</p>
        <Button variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
          {t.refresh}
        </Button>
      </div>
      {status.error && <Alert variant="destructive">{errorText(status.error)}</Alert>}
      {action.error && <Alert variant="destructive">{errorText(action.error)}</Alert>}
      {action.data && (
        <p role="status" className="break-all text-sm text-success">
          {t.exported(action.data.path)}
        </p>
      )}
      {status.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      ) : status.data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y rounded-xl border bg-card px-4 text-card-foreground">
          {status.data?.items.map((item) => {
            const actionable = ["held", "rejected", "expired"].includes(item.state);
            const reason =
              item.reason || (item.heldReason && t.heldReasons[item.heldReason]) || item.lastError || t.noReason;
            return (
              <li key={item.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p className="break-words font-medium">
                    {item.title || item.kind} · {t.states[item.state]}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{item.key}</p>
                  {actionable && <p className="break-words">{reason}</p>}
                  {(item.code || item.heldReason) && (
                    <p className="break-all font-mono text-xs text-muted-foreground">{item.code || item.heldReason}</p>
                  )}
                  {item.state === "rejected" && <p className="text-xs text-muted-foreground">{t.rejectedHint}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.isPending}
                    aria-label={`${t.export}: ${item.key}`}
                    onClick={() => action.mutate({ kind: "export", key: item.key })}
                  >
                    {t.export}
                  </Button>
                  {actionable && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.isPending || item.state === "rejected"}
                        aria-label={`${t.retry}: ${item.key}`}
                        onClick={() => action.mutate({ kind: "retry", key: item.key })}
                      >
                        {t.retry}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={action.isPending}
                        aria-label={`${t.drop}: ${item.key}`}
                        onClick={() => action.mutate({ kind: "drop", key: item.key })}
                      >
                        {t.drop}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
