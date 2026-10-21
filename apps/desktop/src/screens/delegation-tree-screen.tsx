import { ORPCError } from "@orpc/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { DelegationTree, type TreeRunData, treeRefetchMs } from "@xdev-hive/ui/delegation-tree";
import { CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { type Dict, type Lang, useLang, useT } from "@/lib/i18n.ts";
import { thisMachine } from "@/lib/machine-runs.ts";
import { errorText, invoke } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  threads: string;
  loading: string;
  empty: string;
  pick: string;
  offline: string;
  offlineLead: string;
  retry: string;
}> = {
  vi: {
    lead: "Việc Leader đã giao cho agent trên các máy. Bấm run của máy này để xem agent đang chạy, run ở máy khác mở trên web.",
    threads: "Phiên Leader gần đây",
    loading: "Đang đọc…",
    empty: "Chưa có phiên Leader nào. Trò chuyện với Leader trên web để giao việc.",
    pick: "Chọn một phiên Leader để xem cây.",
    offline: "Hub đang vắng",
    offlineLead: "Không đọc được hub nên không hiện cây cũ. App tự thử lại.",
    retry: "Thử lại",
  },
  en: {
    lead: "Work the Leader gave to agents on each machine. Click a run on this machine to see its agent, runs elsewhere open on the web.",
    threads: "Recent Leader conversations",
    loading: "Reading…",
    empty: "No Leader conversations yet. Talk to the Leader on the web to hand out work.",
    pick: "Pick a Leader conversation to see its tree.",
    offline: "Hub is unreachable",
    offlineLead: "The hub cannot be read, so no stale tree is shown. The app keeps retrying.",
    retry: "Retry",
  },
};

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

/**
 * Lỗi do không tới được hub (mạng, hub tắt, proxy trả 5xx) chứ không phải hub từ chối: báo "Hub đang vắng" thay vì một
 * câu lỗi khó hiểu. Lệnh Rust `hub_rpc` lỗi mạng thì ném chuỗi, không thành ORPCError.
 */
export function hubUnreachable(error: unknown): boolean {
  return !(error instanceof ORPCError) || error.status >= 500;
}

/** Màn Cây giao việc (specs/028 US4): phiên Leader gần đây bên trái, cây của phiên chọn bên phải, cùng component với web. */
export function DelegationTreeScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <TreeBody />
    </QueryClientProvider>
  );
}

function TreeBody() {
  const t = useT(text);
  const lang = useLang();
  const threads = useQuery({ ...api.leader.threads.list.queryOptions({ input: {} }), refetchInterval: 30_000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const [machine, setMachine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Chỉ để đánh dấu "máy này"; máy chưa đăng ký thì không run nào là của máy này.
    thisMachine().then(
      (m) => setMachine(m),
      () => setMachine(null),
    );
  }, []);

  const selected = chosen ?? threads.data?.[0]?.id ?? null;

  function openRun(run: TreeRunData) {
    setError(null);
    // R8: run trên máy này mở màn Agent trên máy (chọn sẵn run); run ở máy khác thì log nằm ở máy đó, mở trang run trên web.
    if (machine && run.machine?.id === machine) location.hash = `#/agents/${run.id}`;
    else invoke("open_hub_page", { path: `/runs/${run.id}` }).catch((e) => setError(errorText(e)));
  }

  if (threads.isError && hubUnreachable(threads.error))
    return <Offline onRetry={() => void threads.refetch()} busy={threads.isFetching} />;

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="grid min-w-0 gap-3.5 min-[760px]:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label={t.threads} className="flex min-w-0 flex-col gap-1">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">{t.threads}</h2>
          {threads.isPending ? (
            <p className="px-1 text-sm text-muted-foreground">{t.loading}</p>
          ) : threads.isError ? (
            <Alert variant="destructive">{errorText(threads.error)}</Alert>
          ) : threads.data.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t.empty}</p>
          ) : (
            threads.data.map((thread) => (
              <button
                key={thread.id}
                type="button"
                aria-current={thread.id === selected ? "true" : undefined}
                onClick={() => setChosen(thread.id)}
                className={cn(
                  "grid min-w-0 cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  thread.id === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
              >
                <span className="truncate font-medium">{thread.title}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(thread.updatedAt).toLocaleString(LOCALE[lang], { dateStyle: "short", timeStyle: "short" })}
                </span>
              </button>
            ))
          )}
        </nav>
        <section className="min-w-0 rounded-xl border bg-card p-3 text-card-foreground">
          {selected ? (
            <ThreadTree key={selected} id={selected} machine={machine} onOpenRun={openRun} />
          ) : (
            <p className="text-sm text-muted-foreground">{threads.isPending ? t.loading : t.pick}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ThreadTree({
  id,
  machine,
  onOpenRun,
}: {
  id: string;
  machine: string | null;
  onOpenRun: (run: TreeRunData) => void;
}) {
  const t = useT(text);
  const tree = useQuery({
    ...api.leader.tree.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => treeRefetchMs(query.state.data),
  });
  // Đồng hồ cho thời gian run đang chạy giữa hai lần hỏi hub.
  const [now, setNow] = useState(Date.now());
  const active = !!tree.data?.active;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (tree.isPending) return <p className="text-sm text-muted-foreground">{t.loading}</p>;
  // FR-031: lần hỏi mới lỗi thì bỏ cây đang giữ, không để người xem tưởng đó là trạng thái hiện tại.
  if (tree.isError)
    return hubUnreachable(tree.error) ? (
      <Offline onRetry={() => void tree.refetch()} busy={tree.isFetching} />
    ) : (
      <Alert variant="destructive">{errorText(tree.error)}</Alert>
    );
  return (
    <DelegationTree
      tree={tree.data}
      now={now}
      onOpenRun={onOpenRun}
      isThisMachine={(machineId) => machineId === machine}
    />
  );
}

function Offline({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  const t = useT(text);
  return (
    <div role="status" className="flex flex-col items-start gap-2 rounded-xl border bg-card px-4 py-3">
      <span className="flex items-center gap-2 font-medium">
        <CloudOffIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        {t.offline}
      </span>
      <span className="text-sm text-muted-foreground">{t.offlineLead}</span>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
        <RefreshCwIcon aria-hidden="true" className={cn(busy && "animate-spin")} />
        {t.retry}
      </Button>
    </div>
  );
}
