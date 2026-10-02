// Web Admin pages built on what the machines already report to the hub (docs/design/2026-09-redesign, xDev Hive Web
// Admin): Tổng quan, Lượt chạy, Hàng đợi, Đội máy, Quota & gói, Chi phí, Nhật ký.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import { missingRequired, type AuditEntry, type MachineDetail, type RunRecord, type RunRequest } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { DataTable, type Column } from "#ui/components/DataTable.tsx";
import { Empty, ErrorNote } from "#ui/components/common.tsx";
import { StopAgentsButton } from "#ui/components/StopAgents.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { errorMessage, formatTime, formatUsd, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { hasKey, useT, type MessageKey, type TFunction } from "#ui/i18n/index.tsx";
import { isLive, runDuration, runLabel } from "#ui/lib/runs.ts";
import { RANGE_HOURS, useAdminRange } from "#ui/shell/AdminShell.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { DetailDialog } from "#ui/components/DetailDialog.tsx";
import { ACTION_LABEL, MachineCard } from "#ui/pages/Admin.tsx";
import { Costs } from "#ui/pages/Machines.tsx";
import { HubDetail } from "#ui/pages/Runs.tsx";
import { EventFeed, OpenAlerts } from "./Alerts.tsx";
import { BudgetsCard } from "./Budgets.tsx";

const REFRESH_MS = 15_000;

function useTick(ms = REFRESH_MS): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return n;
}

const RUN_KIND: Record<string, ChipKind> = { running: "running", queued: "neutral", succeeded: "success", failed: "danger", rate_limited: "warning", cancelled: "neutral" };

function Card({ title, sub, action, children, className }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-[14px] border border-line-default bg-surface p-4", className)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-sm/5 font-semibold text-fg-strong">{title}</h2>
        {sub ? <span className="text-xs text-fg-muted">{sub}</span> : null}
        {action ? <span className="ml-auto text-xs">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, warn, href }: { label: string; value: ReactNode; sub: string; warn?: boolean; href?: string }) {
  const body = (
    <>
      <span className="text-xs text-fg-muted">{label}</span>
      <span className={cn("text-[26px]/8 font-bold tabular-nums", warn ? "text-warning" : "text-fg-strong")}>{value}</span>
      <span className="truncate text-xs text-fg-muted">{sub}</span>
    </>
  );
  const cls = "flex min-w-0 flex-col gap-1 rounded-xl border border-line-default bg-surface px-3.5 py-3";
  return href ? (
    <a href={href} className={cn(cls, "hover:border-fg-secondary")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Bar({ percent, warnAt = 80 }: { percent: number | null | undefined; warnAt?: number }) {
  if (typeof percent !== "number") return <span className="text-[11px] text-fg-muted">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative h-[5px] flex-1 rounded-full bg-sunken">
        <span className={cn("absolute inset-y-0 left-0 rounded-full", pct >= warnAt ? "bg-warning-solid" : "bg-primary")} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-8 text-right font-mono text-[11px] text-fg-secondary">{pct}%</span>
    </span>
  );
}

const machineKind = (m: MachineDetail, lacking: boolean): { kind: ChipKind; label: MessageKey } =>
  !m.online ? { kind: "neutral", label: "ops.legend.offline" } : lacking ? { kind: "warning", label: "ops.legend.lacking" } : m.runs.length ? { kind: "running", label: "ops.legend.running" } : { kind: "success", label: "ops.legend.online" };

// ── Tổng quan ──

/** Stop-all for the whole hub, and for one project picked here: the Web Admin has no page per project. */
function StopAgentsBar() {
  const t = useT();
  const projects = useProjects();
  const [project, setProject] = useState("");
  const picked = projects.includes(project) ? project : (projects[0] ?? "");
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      {picked ? (
        <>
          <NativeSelect size="sm" className="font-mono" value={picked} onChange={(e) => setProject(e.target.value)} aria-label={t("tasks.colProject")}>
            {projects.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {/* Keyed: each project's button loads its own state. */}
          <StopAgentsButton key={picked} project={picked} />
        </>
      ) : null}
      <StopAgentsButton project={null} />
    </div>
  );
}

export function OpsOverview() {
  const { client } = useHive();
  const t = useT();
  const range = useAdminRange();
  const tick = useTick();
  const runs = useQuery(() => client.call("runs.list", { limit: 200 }), [client, tick]);
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const policy = useQuery(() => client.call("policy.get", {}), [client]);
  const requests = useQuery(() => client.call("runs.requests", { limit: 200 }), [client, tick]);
  const costs = useQuery(() => client.call("costs.summary", {}), [client, tick]);
  const proposals = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick]);
  const memory = useQuery(() => client.call("memory.list", { status: "pending", limit: 500 }), [client, tick]);

  const list = runs.data ?? [];
  const fleet = machines.data ?? [];
  const since = Date.now() - RANGE_HOURS[range] * 3600_000;
  const finished = list.filter((r) => r.finishedAt && Date.parse(r.finishedAt) >= since);
  const done = finished.filter((r) => r.status === "succeeded").length;
  const failed = finished.filter((r) => r.status === "failed").length;
  const quota = finished.filter((r) => r.status === "rate_limited").length;
  const rate = done + failed + quota ? Math.round((done / (done + failed + quota)) * 100) : null;
  const live = list.filter((r) => r.status === "running");
  const lacking = new Set(policy.data ? fleet.filter((m) => m.setup && missingRequired(policy.data!, m.setup).length > 0).map((m) => m.id) : []);
  const cost = costs.data ? (range === "d1" ? costs.data.total.usd1 : range === "d7" ? costs.data.total.usd7 : costs.data.total.usd30) : null;
  const waiting = (requests.data ?? []).filter((r) => r.status === "pending").length;

  // The last 24 hours in hourly buckets, from the runs the hub has (the list keeps the newest 200).
  const hours = useMemo(() => {
    const now = Date.now();
    const out = Array.from({ length: 24 }, () => ({ done: 0, quota: 0, failed: 0 }));
    for (const r of list) {
      if (!r.finishedAt) continue;
      const h = Math.floor((now - Date.parse(r.finishedAt)) / 3600_000);
      if (h < 0 || h > 23) continue;
      const b = out[23 - h]!;
      if (r.status === "succeeded") b.done++;
      else if (r.status === "rate_limited") b.quota++;
      else if (r.status === "failed") b.failed++;
    }
    return out;
  }, [list]);
  const peak = Math.max(1, ...hours.map((h) => h.done + h.quota + h.failed));

  const profiles = fleet
    .flatMap((m) => m.profiles.map((p) => ({ ...p, machine: m.machine })))
    .filter((p) => p.enabled)
    .sort((a, b) => Math.max(b.sessionPercent ?? -1, b.weekPercent ?? -1) - Math.max(a.sessionPercent ?? -1, a.weekPercent ?? -1))
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-4">
      <StopAgentsBar />
      <ErrorNote error={runs.error ?? machines.error} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2.5">
        <Kpi href="#/admin/runs" label={t("ops.kpi.running")} value={live.length} sub={t("ops.kpi.runningSub", { count: new Set(live.map((r) => r.machineId)).size })} />
        <Kpi href="#/admin/queue" label={t("ops.kpi.queue")} value={waiting} sub={t("ops.kpi.queueSub")} />
        <Kpi label={`${t("ops.kpi.success")} ${t(`ops.range.${range}`)}`} value={rate === null ? "—" : `${rate}%`} sub={t("ops.kpi.successSub", { done, failed, quota })} />
        <Kpi href="#/admin/fleet" label={t("ops.kpi.online")} value={`${fleet.filter((m) => m.online).length}/${fleet.length}`} sub={t("ops.kpi.onlineSub", { count: fleet.filter((m) => !m.online).length })} />
        <Kpi href="#/admin/costs" label={t("ops.kpi.cost", { range: t(`ops.range.${range}`) })} value={cost === null ? "—" : formatUsd(cost)} sub={t("ops.kpi.costSub")} />
        <Kpi
          href="#/admin/review"
          label={t("ops.kpi.pending")}
          value={(proposals.data?.length ?? 0) + (memory.data?.length ?? 0)}
          sub={t("ops.kpi.pendingSub")}
          warn={Boolean((proposals.data?.length ?? 0) + (memory.data?.length ?? 0))}
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] gap-3">
        <Card title={t("ops.runsByHour")} sub={t("ops.runsByHourSub", { count: list.length })}>
          <div className="flex h-[150px] items-end gap-[3px] border-b border-dashed border-line-default">
            {hours.map((h, i) => (
              <div key={i} title={`${t("ops.legend.done")} ${h.done} · ${t("ops.legend.quota")} ${h.quota} · ${t("ops.legend.failed")} ${h.failed}`} className="flex flex-1 flex-col-reverse overflow-hidden rounded-t-[2px]" style={{ height: `${((h.done + h.quota + h.failed) / peak) * 100}%` }}>
                <span className="bg-success-solid" style={{ flexGrow: h.done }} />
                <span className="bg-warning-solid" style={{ flexGrow: h.quota }} />
                <span className="bg-danger-solid" style={{ flexGrow: h.failed }} />
              </div>
            ))}
          </div>
          <div className="flex justify-between font-mono text-[11px] text-fg-muted">
            <span>{t("ops.hoursAgo", { h: 24 })}</span>
            <span>{t("ops.hoursAgo", { h: 16 })}</span>
            <span>{t("ops.hoursAgo", { h: 8 })}</span>
            <span>{t("ops.now")}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
            {(
              [
                ["bg-success-solid", "ops.legend.done"],
                ["bg-warning-solid", "ops.legend.quota"],
                ["bg-danger-solid", "ops.legend.failed"],
              ] as const
            ).map(([c, k]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-xs", c)} />
                {t(k)}
              </span>
            ))}
          </div>
        </Card>
        <OpenAlerts card={(title, action, body) => <Card title={title} action={action}>{body}</Card>} />
        <Card
          title={t("ops.runningNow")}
          action={
            <a className="text-fg-link hover:underline" href="#/admin/runs">
              {t("ops.allRuns")}
            </a>
          }
        >
          {live.length === 0 ? <p className="m-0 text-[13px] text-fg-muted">{t("ops.runningNone")}</p> : null}
          <div className="flex flex-col">
            {live.slice(0, 6).map((r) => (
              <a key={`${r.machineId}/${r.runId}`} href={`#/admin/runs?run=${encodeURIComponent(r.runId)}`} className="grid grid-cols-[62px_minmax(0,1fr)_64px] items-center gap-2 border-b border-line-subtle py-2 last:border-b-0 hover:bg-hover">
                <span className="font-mono text-xs text-fg-brand">{r.taskId}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-fg-strong">{r.taskTitle}</span>
                  <span className="truncate text-[11px] text-fg-muted">
                    {r.machine} · {r.profileId ?? "—"}
                    {r.activity ? ` · ${r.activity}` : ""}
                  </span>
                </span>
                <span className="text-right font-mono text-xs text-running">{runDuration(r)}</span>
              </a>
            ))}
          </div>
          {live.length > 6 ? (
            <a href="#/admin/runs" className="rounded-md border border-line-default py-2 text-center text-xs text-fg-secondary hover:bg-hover">
              {t("ops.moreRunning", { count: live.length - 6 })}
            </a>
          ) : null}
        </Card>
        <EventFeed card={(title, action, body) => <Card title={title} action={action}>{body}</Card>} />
        <Card
          title={t("ops.quotaTop")}
          action={
            <a className="text-fg-link hover:underline" href="#/admin/quota">
              {t("ops.details")}
            </a>
          }
        >
          {profiles.length === 0 ? <p className="m-0 text-[13px] text-fg-muted">{t("ops.noProfiles")}</p> : null}
          <div className="grid grid-cols-[minmax(0,1fr)_110px_110px] items-center gap-x-3 gap-y-2 text-xs">
            {profiles.length ? (
              <>
                <span />
                <span className="text-[11px] text-fg-muted">{t("ops.session")}</span>
                <span className="text-[11px] text-fg-muted">{t("ops.week")}</span>
              </>
            ) : null}
            {profiles.map((p) => (
              <div key={`${p.machine}/${p.id}`} className="contents">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono font-semibold text-fg-strong">{p.id}</span>
                  <span className="truncate text-[11px] text-fg-muted">{p.machine}</span>
                </span>
                <Bar percent={p.sessionPercent} />
                <Bar percent={p.weekPercent} />
              </div>
            ))}
          </div>
        </Card>
        <Card title={t("ops.fleet")}>
          <div className="flex flex-wrap gap-1.5">
            {fleet.map((m) => {
              const k = machineKind(m, lacking.has(m.id));
              const color = { neutral: "bg-neutral-solid", warning: "bg-warning-solid", running: "bg-info-solid", success: "bg-success-solid", danger: "bg-danger-solid", info: "bg-info-solid" }[k.kind];
              return <a key={m.id} href="#/admin/fleet" title={`${m.machine} · ${t(k.label)}`} className={cn("size-[13px] rounded-[3px]", color)} />;
            })}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
            {(
              [
                ["bg-success-solid", "ops.legend.online"],
                ["bg-info-solid", "ops.legend.running"],
                ["bg-warning-solid", "ops.legend.lacking"],
                ["bg-neutral-solid", "ops.legend.offline"],
              ] as const
            ).map(([c, k]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-xs", c)} />
                {t(k)}
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Lượt chạy ──

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OpsRuns() {
  const { client } = useHive();
  const t = useT();
  const tick = useTick(5000);
  const runs = useQuery(() => client.call("runs.list", { limit: 200 }), [client, tick]);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => runs.data ?? [], [runs.data]);
  const key = (r: RunRecord) => `${r.machineId}/${r.runId}`;
  const current = list.find((r) => key(r) === selected) ?? null;
  useEffect(() => {
    const run = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("run");
    const found = run ? list.find((r) => r.runId === run) : undefined;
    if (found) setSelected(key(found));
  }, [list]);

  const columns: Array<Column<RunRecord>> = [
    { key: "status", label: t("ops.col.status"), width: "104px", render: (r) => <Chip kind={RUN_KIND[r.status] ?? "neutral"}>{runLabel("runStatus", r.status)}</Chip>, sortValue: (r) => r.status },
    { key: "task", label: t("ops.col.task"), width: "70px", mono: true, render: (r) => r.taskId, sortValue: (r) => r.taskId },
    { key: "work", label: t("ops.col.work"), width: "minmax(220px,1fr)", strong: true, render: (r) => r.taskTitle, sub: (r) => r.activity ?? r.error ?? runLabel("agentRole", r.role), title: (r) => r.taskTitle, sortValue: (r) => r.taskTitle },
    { key: "project", label: t("ops.col.project"), width: "140px", mono: true, render: (r) => r.project, sortValue: (r) => r.project },
    { key: "machine", label: t("ops.col.machine"), width: "118px", mono: true, render: (r) => r.machine, sortValue: (r) => r.machine },
    { key: "profile", label: t("ops.col.profile"), width: "112px", mono: true, render: (r) => r.profileId ?? "—", sortValue: (r) => r.profileId ?? "" },
    { key: "cost", label: t("ops.col.cost"), width: "64px", align: "right", mono: true, render: (r) => (r.costUsd === null ? "—" : formatUsd(r.costUsd)), sortValue: (r) => r.costUsd ?? -1 },
    { key: "duration", label: t("ops.col.duration"), width: "76px", align: "right", mono: true, render: (r) => runDuration(r) || "—", sortValue: (r) => (r.startedAt ? (r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt) : -1) },
    { key: "at", label: t("ops.col.at"), width: "110px", align: "right", render: (r) => formatTime(r.createdAt), sortValue: (r) => r.createdAt },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="min-w-0">
        <ErrorNote error={runs.error} />
        <DataTable
          rows={list}
          columns={columns}
          rowKey={key}
          noun={t("ops.noun.runs")}
          minWidth={1000}
          searchText={(r) => `${r.runId} ${r.taskId} ${r.taskTitle} ${r.project} ${r.machine} ${r.profileId ?? ""}`}
          filters={[
            { key: "status", label: t("ops.col.status"), value: (r) => r.status, options: ["running", "queued", "succeeded", "failed", "rate_limited", "cancelled"].map((s) => ({ value: s, label: runLabel("runStatus", s) })) },
            { key: "project", label: t("ops.col.project"), value: (r) => r.project },
            { key: "machine", label: t("ops.col.machine"), value: (r) => r.machine },
            { key: "profile", label: t("ops.col.profile"), value: (r) => r.profileId ?? "" },
          ]}
          bulk={[{ id: "csv", label: t("ops.csv") }]}
          onBulk={(_, rows) =>
            download(
              "runs.csv",
              csv([
                ["run", "status", "project", "task", "title", "machine", "profile", "cost_usd", "created", "started", "finished"],
                ...rows.map((r) => [r.runId, r.status, r.project, r.taskId, r.taskTitle, r.machine, r.profileId ?? "", r.costUsd?.toString() ?? "", r.createdAt, r.startedAt ?? "", r.finishedAt ?? ""]),
              ]),
            )
          }
          onRowClick={(r) => setSelected(key(r))}
          selectedKey={selected}
        />
      </div>
      {/* A popup, not a panel beside the table: a review's verdict and the log need the room (roadmap 30b). */}
      <DetailDialog open={current !== null} onClose={() => setSelected(null)} title={current ? `${current.runId} · ${current.taskTitle}` : ""}>
        {current ? <HubDetail key={key(current)} run={current} latestReview={false} roomy onChanged={runs.reload} /> : null}
      </DetailDialog>
    </div>
  );
}

// ── Hàng đợi ──

export function OpsQueue() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const tick = useTick(5000);
  const requests = useQuery(() => client.call("runs.requests", { limit: 200 }), [client, tick]);
  const runs = useQuery(() => client.call("runs.list", { limit: 200 }), [client, tick]);
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const action = useAction();
  const list = requests.data ?? [];
  const pending = list.filter((r) => r.status === "pending");
  // Runs a machine queued (from its Board or from these requests), and why each waits: the machine's own reason.
  const queued = (runs.data ?? []).filter((r) => r.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const place = new Map<string, number>();
  const numbered = queued.map((r) => {
    const n = (place.get(r.machineId) ?? 0) + 1;
    place.set(r.machineId, n);
    return { r, n };
  });
  /** Why a request no machine took yet still waits. */
  const whyPending = (r: RunRequest): string => {
    const m = (machines.data ?? []).find((x) => x.id === r.machineId);
    if (!m) return t("ops.queue.reasonGone", { machine: r.machine });
    if (!m.online) return t("ops.queue.reasonOffline", { machine: m.machine, time: formatTime(m.lastSeen) });
    if (!m.acceptsRuns) return t("ops.queue.reasonNoAccept", { machine: m.machine });
    return t("ops.queue.reasonNext", { machine: m.machine });
  };
  const since = (iso: string) => {
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
    return m < 60 ? `${m} ph` : `${Math.floor(m / 60)} giờ`;
  };
  const columns: Array<Column<RunRequest>> = [
    { key: "id", label: "#", width: "56px", mono: true, render: (r) => r.id, sortValue: (r) => r.id },
    { key: "status", label: t("ops.col.status"), width: "120px", render: (r) => <Chip kind={r.status === "pending" ? "info" : r.status === "accepted" ? "success" : r.status === "rejected" ? "danger" : "neutral"}>{t(`requestStatus.${r.status}`)}</Chip>, sortValue: (r) => r.status },
    { key: "task", label: t("ops.col.task"), width: "70px", mono: true, render: (r) => r.taskId },
    { key: "work", label: t("ops.col.work"), width: "minmax(220px,1fr)", strong: true, render: (r) => r.taskTitle, sub: (r) => [runLabel("agentRole", r.role), r.project, r.candidates > 1 ? t("ops.candidates", { n: r.candidates }) : null, r.error?.message].filter(Boolean).join(" · ") },
    { key: "reason", label: t("ops.col.reason"), width: "minmax(180px,0.8fr)", render: (r) => (r.status === "pending" ? <span className="text-xs text-fg-secondary">{whyPending(r)}</span> : "") },
    { key: "machine", label: t("ops.col.machine"), width: "120px", mono: true, render: (r) => r.machine, sub: (r) => r.profileId ?? "" },
    { key: "by", label: t("ops.col.by"), width: "120px", render: (r) => r.requestedBy, sub: (r) => since(r.requestedAt), sortValue: (r) => r.requestedAt },
    {
      key: "act",
      label: "",
      width: "80px",
      align: "right",
      render: (r) =>
        r.status === "pending" ? (
          <Button
            size="xs"
            variant="danger-outline"
            disabled={action.busy}
            onClick={(e) => {
              e.stopPropagation();
              void action.run(async () => {
                await client.call("runs.cancelRequest", { id: r.id });
                toast(t("ops.cancelledRequest", { id: r.id }));
                requests.reload();
              });
            }}
          >
            {t("ops.cancelRequest")}
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <ErrorNote error={requests.error ?? action.error ?? runs.error} />
      <section className="flex flex-col rounded-[14px] border border-line-default bg-surface px-4 pt-3.5 pb-2">
        <h2 className="m-0 pb-1.5 text-sm font-semibold text-fg-strong">{t("ops.queue.onMachines", { count: queued.length })}</h2>
        {runs.data && !queued.length ? <p className="m-0 pb-2 text-[13px] text-fg-muted">{t("ops.queue.noneQueued")}</p> : null}
        {numbered.map(({ r, n }) => (
          <div key={`${r.machineId}/${r.runId}`} className="grid grid-cols-[34px_62px_minmax(0,1fr)_minmax(0,0.9fr)] items-center gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
            <span className="font-mono text-xs text-fg-muted">#{n}</span>
            <span className="font-mono text-xs text-fg-brand">{r.taskId}</span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium text-fg-strong">{r.taskTitle}</span>
              <span className="truncate text-[11px] text-fg-muted">
                {runLabel("agentRole", r.role)} · <span className="font-mono">{r.project}</span> · {r.machine} · {t("ops.queue.waiting", { time: runDuration({ ...r, startedAt: r.createdAt }) })}
              </span>
            </span>
            <span className={cn("rounded-md px-2.5 py-1.5 text-xs/[17px]", r.error ? "bg-warning-soft text-fg-strong" : "bg-sunken text-fg-secondary")}>{r.error ?? t("ops.queue.reasonSlot")}</span>
          </div>
        ))}
        <span className="pt-2 text-[11px]/4 text-fg-muted">{t("ops.queue.order")}</span>
      </section>
      <h2 className="m-0 mt-1 text-sm font-semibold text-fg-strong">{t("ops.queue.requests")}</h2>
      {requests.data && !pending.length ? <Empty>{t("ops.queueEmpty")}</Empty> : null}
      {list.length ? (
      <DataTable
        rows={list}
        columns={columns}
        rowKey={(r) => String(r.id)}
        noun={t("ops.noun.requests")}
        searchText={(r) => `${r.id} ${r.taskId} ${r.taskTitle} ${r.project} ${r.machine} ${r.requestedBy}`}
        filters={[
          { key: "status", label: t("ops.col.status"), value: (r) => r.status, options: ["pending", "accepted", "rejected", "cancelled", "expired"].map((s) => ({ value: s, label: t(`requestStatus.${s as RunRequest["status"]}`) })) },
          { key: "machine", label: t("ops.col.machine"), value: (r) => r.machine },
        ]}
      />
      ) : null}
    </div>
  );
}

// ── Đội máy ──

export function OpsFleet() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const tick = useTick();
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const policy = useQuery(() => client.call("policy.get", {}), [client]);
  const [selected, setSelected] = useState<string | null>(null);
  const list = machines.data ?? [];
  const missing = (m: MachineDetail) => (policy.data && m.setup ? missingRequired(policy.data, m.setup).length : 0);
  const current = list.find((m) => m.id === selected) ?? null;
  const waiting = list.reduce((n, m) => n + m.commands.filter((c) => c.status === "pending" || c.status === "running").length, 0);
  const columns: Array<Column<MachineDetail>> = [
    { key: "machine", label: t("ops.col.machine"), width: "minmax(180px,1fr)", mono: true, strong: true, render: (m) => m.machine, sub: (m) => m.projects.join(", "), sortValue: (m) => m.machine },
    {
      key: "state",
      label: t("ops.col.status"),
      width: "120px",
      render: (m) => {
        const k = machineKind(m, missing(m) > 0);
        return <Chip kind={m.duplicate ? "danger" : k.kind}>{m.duplicate ? t("machineState.duplicate") : m.online ? t("machineState.online") : t("machineState.offline")}</Chip>;
      },
      sortValue: (m) => (m.online ? 1 : 0),
    },
    { key: "heartbeat", label: t("ops.col.heartbeat"), width: "120px", render: (m) => formatTime(m.lastSeen), sortValue: (m) => m.lastSeen },
    { key: "version", label: t("ops.col.version"), width: "90px", mono: true, render: (m) => m.version, sortValue: (m) => m.version },
    { key: "runs", label: t("ops.col.runs"), width: "56px", align: "right", mono: true, render: (m) => m.runs.length, sortValue: (m) => m.runs.length },
    { key: "profiles", label: t("ops.col.profiles"), width: "56px", align: "right", mono: true, render: (m) => m.profiles.length, sortValue: (m) => m.profiles.length },
    {
      key: "policy",
      label: t("ops.col.policy"),
      width: "120px",
      render: (m) => (missing(m) ? <Chip kind="warning">{t("ops.policyMissing", { count: missing(m) })}</Chip> : m.setup ? <Chip kind="success">{t("ops.policyOk")}</Chip> : "—"),
      sortValue: (m) => missing(m),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote error={machines.error ?? policy.error} />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Kpi label={t("admin.statMachines")} value={list.length} sub="" />
        <Kpi label={t("machineState.online")} value={list.filter((m) => m.online).length} sub="" />
        <Kpi label={t("admin.statLacking")} value={list.filter((m) => missing(m) > 0).length} sub="" warn={list.some((m) => missing(m) > 0)} />
        <Kpi label={t("admin.statOpen")} value={waiting} sub="" />
      </div>
      <div className="min-w-0">
        <div className="min-w-0">
          <DataTable
            rows={list}
            columns={columns}
            rowKey={(m) => m.id}
            noun={t("ops.noun.machines")}
            minWidth={820}
            searchText={(m) => `${m.machine} ${m.version} ${m.projects.join(" ")}`}
            filters={[
              { key: "state", label: t("ops.col.status"), value: (m) => (m.online ? "online" : "offline"), options: [{ value: "online", label: t("machineState.online") }, { value: "offline", label: t("machineState.offline") }] },
              { key: "version", label: t("ops.col.version"), value: (m) => m.version },
            ]}
            bulk={[{ id: "remove", label: t("ops.removeMachines"), danger: true }]}
            onBulk={(_, picked) => {
              // Only machines that stopped reporting: a live one would come back at its next heartbeat anyway.
              const rows = picked.filter((m) => !m.online);
              if (!rows.length || !window.confirm(t("ops.confirmRemoveMachines", { machines: rows.map((m) => m.machine).join(", ") }))) return;
              void Promise.all(rows.map((m) => client.call("machines.remove", { id: m.id }))).then(
                () => {
                  toast(t("ops.removedMachines", { count: rows.length }));
                  machines.reload();
                },
                (err: unknown) => toast(errorMessage(err), { tone: "error" }),
              );
            }}
            onRowClick={(m) => setSelected(m.id)}
            selectedKey={selected}
            dim={(m) => !m.online}
          />
        </div>
      </div>
      <DetailDialog open={current !== null} onClose={() => setSelected(null)} title={current?.machine ?? ""} className="h-auto max-h-[85vh]">
        <div className="min-h-0 overflow-y-auto p-5 pr-12">
          {current ? <MachineCard key={current.id} machine={current} policy={policy.data ?? null} onChanged={machines.reload} /> : null}
        </div>
      </DetailDialog>
    </div>
  );
}

// ── Quota & gói ──

export function OpsQuota() {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const tick = useTick();
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const cooldowns = useQuery(() => client.call("cooldowns.list", {}), [client, tick]);
  const action = useAction();
  const profiles = (machines.data ?? []).flatMap((m) => m.profiles.map((p) => ({ ...p, machine: m.machine, online: m.online })));
  const rest = (account: string | null) => (account ? (cooldowns.data ?? []).find((c) => c.account === account) : undefined);
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote error={machines.error ?? cooldowns.error ?? action.error} />
      {machines.data && !profiles.length ? <Empty>{t("ops.noProfiles")}</Empty> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {profiles.map((p) => {
          const c = rest(p.account);
          const kind: ChipKind = !p.enabled ? "neutral" : !p.installed || p.loggedIn === false ? "danger" : p.overLimit || c || p.cooldownUntil ? "warning" : "success";
          return (
            <section key={`${p.machine}/${p.id}`} className="flex flex-col gap-2.5 rounded-xl border border-line-default bg-surface p-3.5">
              <div className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", p.online ? "bg-success-solid" : "bg-neutral-solid")} />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-fg-strong">{p.id}</span>
                <Chip kind={kind}>
                  {!p.enabled
                    ? t("agents.state.off")
                    : !p.installed
                      ? t("agents.state.noCli")
                      : p.loggedIn === false
                        ? t("agents.state.signedOut")
                        : p.overLimit
                          ? t("agents.state.overLimit")
                          : c || p.cooldownUntil
                            ? t("agents.state.resting")
                            : t("agents.state.ready")}
                </Chip>
              </div>
              <span className="text-xs text-fg-muted">
                {p.label} · {p.machine}
                {p.account ? ` · ${p.account}` : ""}
              </span>
              <div className="grid grid-cols-[48px_1fr] items-center gap-x-2 gap-y-1.5 text-[11px] text-fg-muted">
                <span>{t("ops.session")}</span>
                <Bar percent={p.sessionPercent} />
                <span>{t("ops.week")}</span>
                <Bar percent={p.weekPercent} />
              </div>
              {c || p.cooldownUntil ? (
                <div className="flex items-center gap-2 text-xs text-warning">
                  <span className="min-w-0 flex-1 truncate" title={c?.reason}>
                    {t("ops.restingUntil", { time: formatTime(c?.until ?? p.cooldownUntil) })}
                  </span>
                  {c ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await client.call("cooldowns.clear", { account: c.account });
                          toast(t("ops.restCleared", { account: c.account }));
                          cooldowns.reload();
                        })
                      }
                    >
                      {t("ops.clearRest")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ── Chi phí ──

export function OpsCosts() {
  const { client } = useHive();
  const tick = useTick();
  const costs = useQuery(() => client.call("costs.summary", {}), [client, tick]);
  return (
    <div className="flex flex-col gap-4">
      <BudgetsCard tick={tick} />
      <ErrorNote error={costs.error} />
      {costs.data ? <Costs summary={costs.data} /> : null}
    </div>
  );
}

// ── Nhật ký ──

/** The audit log's groups, by the action's prefix. */
function groupOf(action: string): string {
  const p = action.split(".")[0] ?? "";
  if (p === "docs" || p === "proposals") return "docs";
  if (p === "memory") return "memory";
  if (p === "tasks") return "tasks";
  if (p === "chat") return "chat";
  if (p === "users" || p === "auth" || p === "tokens") return "accounts";
  // Stop-all stops what the machines run; spending caps decide what they start.
  if (p === "machines" || p === "admin" || p === "cooldowns" || p === "policy" || p === "agents" || p === "budgets") return "machines";
  if (p === "systems") return "projects";
  return "connections";
}

type AuditFilter = { agent: string; user: string; run: string };
const NO_FILTER: AuditFilter = { agent: "", user: "", run: "" };

export function OpsAudit() {
  const { client } = useHive();
  const t = useT();
  // The hub filters (admin.audit), so an older entry shows up too; sent when the admin presses Lọc, not per keystroke.
  const [draft, setDraft] = useState<AuditFilter>(NO_FILTER);
  const [filter, setFilter] = useState<AuditFilter>(NO_FILTER);
  const log = useQuery(
    () =>
      client.call("admin.audit", {
        limit: 300,
        ...(filter.agent ? { agent: filter.agent } : {}),
        ...(filter.user ? { user: filter.user } : {}),
        ...(filter.run ? { run: filter.run } : {}),
      }),
    [client, filter],
  );
  const filtered = filter.agent !== "" || filter.user !== "" || filter.run !== "";
  const label = (a: string) => (ACTION_LABEL[a] ? t(ACTION_LABEL[a]!) : a);
  const detail = (e: AuditEntry) => (e.detailKey && hasKey(e.detailKey) ? t(e.detailKey as MessageKey, e.detailVars) : e.detail);
  const groups: Array<[string, string]> = [
    ["docs", t("nav.docs")],
    ["memory", t("nav.memory")],
    ["tasks", t("nav.tasks")],
    ["chat", t("nav.chat")],
    ["accounts", t("ops.nav.users")],
    ["machines", t("nav.machines")],
    ["projects", t("ops.nav.projects")],
    ["connections", t("ops.nav.webhooks")],
  ];
  const columns: Array<Column<AuditEntry>> = [
    { key: "at", label: t("ops.col.at"), width: "130px", render: (e) => formatTime(e.at), sortValue: (e) => e.at },
    { key: "actor", label: t("ops.col.actor"), width: "minmax(140px,0.8fr)", mono: true, render: (e) => e.actor, sortValue: (e) => e.actor },
    { key: "agent", label: t("ops.col.agent"), width: "minmax(120px,0.6fr)", mono: true, render: (e) => e.agent ?? "—", sub: (e) => (e.agent && e.onBehalf ? t("ops.audit.onBehalf", { user: e.onBehalf }) : null), sortValue: (e) => e.agent ?? "" },
    {
      key: "run",
      label: t("ops.col.run"),
      width: "96px",
      mono: true,
      // Opens the run on Lượt chạy (OpsRuns reads ?run=).
      render: (e) =>
        e.run ? (
          <a className="text-primary underline underline-offset-2" href={`#/admin/runs?run=${encodeURIComponent(e.run)}`}>
            {e.run}
          </a>
        ) : (
          "—"
        ),
      sortValue: (e) => e.run ?? "",
    },
    { key: "action", label: t("ops.col.action"), width: "minmax(150px,0.8fr)", render: (e) => label(e.action), sortValue: (e) => e.action },
    { key: "group", label: t("ops.group2"), width: "110px", render: (e) => groups.find(([g]) => g === groupOf(e.action))?.[1] ?? "" },
    { key: "target", label: t("ops.col.target"), width: "minmax(140px,0.8fr)", mono: true, render: (e) => e.target, title: (e) => e.target },
    { key: "detail", label: t("ops.col.detail"), width: "minmax(200px,1.4fr)", render: (e) => detail(e), title: (e) => detail(e) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          setFilter({ agent: draft.agent.trim(), user: draft.user.trim(), run: draft.run.trim() });
        }}
      >
        {(["agent", "user", "run"] as const).map((k) => (
          <Input
            key={k}
            className="h-8 w-44 font-mono text-xs"
            value={draft[k]}
            placeholder={t(`ops.audit.filter.${k}`)}
            aria-label={t(`ops.audit.filter.${k}`)}
            maxLength={k === "run" ? 60 : 100}
            onChange={(ev) => setDraft({ ...draft, [k]: ev.target.value })}
          />
        ))}
        <Button type="submit" size="sm" variant="outline">
          {t("ops.audit.apply")}
        </Button>
        {filtered ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(NO_FILTER);
              setFilter(NO_FILTER);
            }}
          >
            {t("ops.audit.clear")}
          </Button>
        ) : null}
      </form>
      <ErrorNote error={log.error} />
      <DataTable
        rows={log.data ?? []}
        columns={columns}
        rowKey={(e) => String(e.id)}
        noun={t("ops.noun.entries")}
        minWidth={1200}
        searchText={(e) => `${e.actor} ${e.agent ?? ""} ${e.onBehalf ?? ""} ${e.run ?? ""} ${e.action} ${e.target} ${e.detail}`}
        filters={[
          { key: "group", label: t("ops.group2"), value: (e) => groupOf(e.action), options: groups.map(([value, l]) => ({ value, label: l })) },
          { key: "action", label: t("ops.col.action"), value: (e) => e.action, options: Object.keys(ACTION_LABEL).map((a) => ({ value: a, label: label(a) })) },
        ]}
      />
    </div>
  );
}

export type OpsT = TFunction;
