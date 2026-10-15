import type { RunState } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConnectHive } from "@/components/connect-hive.tsx";
import { useLinkedAccount } from "@/lib/account.ts";
import { hubTool } from "@/lib/hub.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { ACTIVE, RUN_STATE_TEXT, stateTone } from "@/lib/run-state.ts";
import { errorText, invoke } from "@/lib/tauri.ts";
import { formatTokens } from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkerState, WORKER_DOT, workerSentence } from "@/lib/worker.ts";

/** Một run trong kết quả tool run_list của hub. */
export interface MachineRun {
  id: string;
  kind: "code" | "review" | "plan" | "leader" | "doccheck";
  state: string;
  taskKey: string;
  title: string;
  projectId: string;
  project: { key: string; name: string } | null;
  cli: string | null;
  model: string | null;
  machine: string | null;
  costUsd: number | null;
  tokensIn: number;
  prUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Thời lượng của run: đang chạy thì tính tới giờ. */
export function duration(run: Pick<MachineRun, "startedAt" | "finishedAt">, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
}

const text: Dict<{
  lead: string;
  noMachine: string;
  noAccount: string;
  loading: string;
  empty: string;
  refresh: string;
  running: (n: number) => string;
  today: (n: number) => string;
  cost: string;
  colRun: string;
  colProject: string;
  colCli: string;
  colState: string;
  colWhen: string;
  colTime: string;
  colCost: string;
  open: (key: string) => string;
  kinds: Record<MachineRun["kind"], string>;
  ago: (min: number) => string;
  secs: (s: number) => string;
}> = {
  vi: {
    lead: "Run mà hub đã giao cho máy này, mới nhất trước. Bấm một dòng để xem log và kết quả trên web của hub.",
    noMachine: "Máy chưa đăng ký với hub: đăng ký ở cửa sổ Đăng ký máy để nhận việc.",
    noAccount: "Kết nối Hive để xem run của máy này.",
    loading: "Đang đọc…",
    empty: "Máy này chưa chạy run nào.",
    refresh: "Làm mới",
    running: (n) => `${n} run đang chạy`,
    today: (n) => `${n} run trong 24 giờ`,
    cost: "Chi phí 24 giờ",
    colRun: "Run",
    colProject: "Dự án",
    colCli: "CLI",
    colState: "Trạng thái",
    colWhen: "Bắt đầu",
    colTime: "Thời gian",
    colCost: "Chi phí",
    open: (key) => `Mở ${key} trên web`,
    kinds: { code: "Viết code", review: "Review chéo", plan: "Kế hoạch", leader: "Leader", doccheck: "Kiểm tài liệu" },
    ago: (min) =>
      min < 1
        ? "vừa xong"
        : min < 60
          ? `${min} phút trước`
          : min < 1440
            ? `${Math.round(min / 60)} giờ trước`
            : `${Math.round(min / 1440)} ngày trước`,
    secs: (s) => (s < 60 ? `${s} giây` : s < 3600 ? `${Math.round(s / 60)} phút` : `${(s / 3600).toFixed(1)} giờ`),
  },
  en: {
    lead: "Runs the hub gave to this machine, newest first. Click a row to see its log and result on the hub's web.",
    noMachine:
      "This machine is not registered with a hub yet: register it in the Register machine window to take work.",
    noAccount: "Connect to Hive to see this machine's runs.",
    loading: "Reading…",
    empty: "This machine has not run anything yet.",
    refresh: "Refresh",
    running: (n) => `${n} running`,
    today: (n) => `${n} runs in 24 hours`,
    cost: "Cost, 24 hours",
    colRun: "Run",
    colProject: "Project",
    colCli: "CLI",
    colState: "State",
    colWhen: "Started",
    colTime: "Duration",
    colCost: "Cost",
    open: (key) => `Open ${key} on the web`,
    kinds: { code: "Coding", review: "Cross-review", plan: "Plan", leader: "Leader", doccheck: "Doc check" },
    ago: (min) =>
      min < 1
        ? "just now"
        : min < 60
          ? `${min} min ago`
          : min < 1440
            ? `${Math.round(min / 60)} h ago`
            : `${Math.round(min / 1440)} d ago`,
    secs: (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`),
  },
};

/** Màn Lượt chạy trên máy (mục "runs" của AppNav.dc.html): run hub đã giao cho chính máy này, đọc qua tool run_list. */
export function RunsScreen() {
  const t = useT(text);
  const lang = useLang();
  const account = useLinkedAccount();
  const worker = useWorkerState();
  const [machine, setMachine] = useState<string | null | undefined>(undefined);
  const [runs, setRuns] = useState<MachineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    invoke<string | null>("this_machine").then(
      (m) => setMachine(m),
      () => setMachine(null),
    );
  }, []);

  const load = useCallback(async () => {
    if (!machine || !account) return;
    setLoading(true);
    try {
      const list = await hubTool<{ runs: MachineRun[] }>("run_list", { machine, limit: 50 });
      setRuns(list.runs);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [machine, account]);

  // Đọc khi mở và nửa phút một lần, để run đang chạy đổi trạng thái mà không cần bấm làm mới.
  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 30_000);
    return () => clearInterval(h);
  }, [load]);

  const dayAgo = now - 86_400_000;
  const recent = (runs ?? []).filter((r) => Date.parse(r.createdAt) >= dayAgo);
  const active = (runs ?? []).filter((r) => ACTIVE.has(r.state)).length;
  const cost = recent.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const blocker = machine === null ? t.noMachine : !account ? t.noAccount : null;

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t.lead}</p>
          {blocker && <p className="text-sm text-muted-foreground">{blocker}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || !!blocker}>
          <RefreshCwIcon aria-hidden="true" className={cn(loading && "animate-spin")} />
          {t.refresh}
        </Button>
      </header>

      <section className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-3">
        <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden="true" className={cn("size-2 rounded-full", WORKER_DOT[worker?.kind ?? "stopped"])} />
            {worker ? workerSentence(worker.label) : t.loading}
          </span>
          <span className="font-mono text-2xl font-semibold tracking-tight">{runs ? active : "—"}</span>
          <span className="text-xs text-muted-foreground">{t.running(active)}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
          <span className="text-sm text-muted-foreground">{machine ?? "—"}</span>
          <span className="font-mono text-2xl font-semibold tracking-tight">{runs ? recent.length : "—"}</span>
          <span className="text-xs text-muted-foreground">{t.today(recent.length)}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
          <span className="text-sm text-muted-foreground">{t.cost}</span>
          <span className="font-mono text-2xl font-semibold tracking-tight">{runs ? `$${cost.toFixed(2)}` : "—"}</span>
          <span className="text-xs text-muted-foreground">
            {runs
              ? formatTokens(
                  recent.reduce((a, r) => a + r.tokensIn, 0),
                  lang,
                )
              : ""}
          </span>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card text-card-foreground">
        {machine !== null && !account ? (
          <ConnectHive inline note={t.noAccount} />
        ) : runs === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{blocker ?? t.loading}</p>
        ) : runs.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <Table className="min-w-160">
            <TableHeader>
              <TableRow>
                <Th>{t.colRun}</Th>
                <Th>{t.colProject}</Th>
                <Th>{t.colCli}</Th>
                <Th>{t.colState}</Th>
                <Th>{t.colWhen}</Th>
                <Th className="text-right">{t.colTime}</Th>
                <Th className="text-right">{t.colCost}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const secs = duration(r, now);
                return (
                  <TableRow key={r.id}>
                    <Td className="max-w-72">
                      <button
                        type="button"
                        className="flex w-full min-w-0 flex-col text-left"
                        aria-label={t.open(r.taskKey)}
                        onClick={() =>
                          void invoke("open_hub_page", { path: `/runs/${r.id}` }).catch((e) => setError(errorText(e)))
                        }
                      >
                        <span className="truncate font-mono text-sm font-medium">{r.taskKey}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {t.kinds[r.kind]} · {r.title}
                        </span>
                      </button>
                    </Td>
                    <Td className="text-sm whitespace-nowrap">{r.project?.name ?? "—"}</Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{r.cli ?? "—"}</Td>
                    <Td>
                      <Pill tone={stateTone(r.state)} dot={ACTIVE.has(r.state)}>
                        {RUN_STATE_TEXT[lang][r.state as RunState] ?? r.state}
                      </Pill>
                    </Td>
                    <Td className="text-xs whitespace-nowrap text-muted-foreground">
                      {t.ago(Math.round((now - Date.parse(r.startedAt ?? r.createdAt)) / 60_000))}
                    </Td>
                    <Td className="text-right font-mono text-xs">{secs === null ? "—" : t.secs(secs)}</Td>
                    <Td className="text-right font-mono text-xs">
                      {r.costUsd === null ? "—" : `$${r.costUsd.toFixed(2)}`}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
