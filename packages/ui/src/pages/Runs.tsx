import { MergeQueue } from "#ui/components/MergeQueue.tsx";
import { useChatPageContext } from "#ui/components/ChatSession.tsx";
import { RunRedispatch } from "#ui/components/RunRedispatch.tsx";
import { RunDiff, type DiffFixTarget } from "#ui/components/RunDiff.tsx";
import type { DiffReview } from "@xdev-hive/core";
import { ServiceFilter, useServiceFilter } from "#ui/components/ServiceFilter.tsx";
// Lượt chạy (docs/design/2026-09-redesign, xDev Hive Client; roadmap 39e): one line per run, the task's title first and
// what came of it in words under it. The app lists this machine's runs only (roadmap 35a); the web lists every machine's
// (runs.push). The detail opens on the summary — the agent's last words, its steps, the MR — and keeps the log in a tab.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { TerminalEntry } from "#ui/components/RemoteTerminal.tsx";
import { ModelRunChip } from "#ui/components/ModelChip.tsx";
import { Wrench, X } from "lucide-react";
import { cn } from "cn";
import { cacheReadShare, parseVerdict, type AgentRun, type RunCompression, type RunRecord, type RunMessage, type RunRequest, type RunTokens } from "@xdev-hive/core";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Sheet } from "@xdev-hive/ui/components/ui/sheet";
import { RolesSheet } from "#ui/components/AgentSheets.tsx";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ArtifactContext, ArtifactRows, ArtifactText, useArtifacts } from "#ui/components/Artifacts.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { Tag } from "@xdev-hive/ui/components/ui/primitives";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { cosmicAssets } from "#ui/assets/cosmic.ts";
import "./Runs.css";
import { errorMessage, formatCount, formatTime, formatUsd, useAction, useCan, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { fixInstructions, handoffSections, isLive, latestReviews, mrLabel, requestErrorText, runDuration, runGroup, runLabel, runOutcome, waitingReason } from "#ui/lib/runs.ts";
import { logHeader, parseLog, parsePatch, runSteps, type DiffFile, type LogLevel } from "#ui/lib/runlog.ts";
import { activeIntl } from "#ui/i18n/translate.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

/** Machines push every 5 s while something runs; nothing to follow, a slow check for new runs. */
const LIVE_MS = 3000;
const IDLE_MS = 20_000;

/** Re-runs a query every few seconds, faster while `live`. */
function useRefresh(live: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setTick((n) => n + 1), live ? LIVE_MS : IDLE_MS);
    return () => clearTimeout(timer);
  }, [tick, live]);
  return tick;
}

type Row = { src: "local"; key: string; run: AgentRun } | { src: "hub"; key: string; run: RunRecord };

const rowId = (r: Row) => (r.src === "local" ? r.run.id : r.run.runId);
const rowTime = (r: Row) => r.run.finishedAt ?? r.run.startedAt ?? r.run.createdAt;

const STATE: Record<string, "running" | "success" | "danger" | "warning" | "neutral"> = {
  running: "running",
  queued: "neutral",
  succeeded: "success",
  failed: "danger",
  rate_limited: "warning",
  cancelled: "neutral",
};
const CHIP = {
  running: "bg-running-soft text-running",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-neutral-soft text-neutral",
} as const;

type Filter = "focus" | "all" | "live" | "waiting" | "bad" | "done";
const FILTERS: Filter[] = ["focus", "all", "live", "waiting", "bad", "done"];

export function RunsPage() {
  const { client, me, scope } = useHive();
  const t = useT();
  const desktop = client.desktop;
  const hubMode = me.mode === "hub";
  // Roadmap 35a: connected to a hub, the app still shows this machine's work only. The team's runs are the web's,
  // which is why the page's subtitle here reads "Run trên máy này".
  const teamRuns = hubMode && !desktop;
  const [active, setActive] = useState(false);
  const mobileDetail = useMobileDetail("run");
  const [linkedRun, setLinkedRun] = useState(mobileDetail.value);
  useEffect(() => { if (mobileDetail.value) setLinkedRun(mobileDetail.value); }, [mobileDetail.value]);
  const linked = useQuery(async () => {
    const slash = linkedRun?.lastIndexOf("/") ?? -1;
    return teamRuns && slash > 0 ? client.call("runs.get", { machineId: linkedRun!.slice(0, slash), runId: linkedRun!.slice(slash + 1) }) : null;
  }, [client, teamRuns, linkedRun]);
  const [filter, setFilter] = useState<Filter>(teamRuns ? "focus" : "all");
  const [taskFilter, setTaskFilter] = useState("");
  const [machineFilter, setMachineFilter] = useState("");
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [linkedGroup, clearLinkedGroup] = useHashParam("group");
  useEffect(() => {
    if (linkedGroup) { setGroupFilter(linkedGroup); setFilter("all"); clearLinkedGroup(); }
  }, [linkedGroup, clearLinkedGroup]);
  const tick = useRefresh(active);
  const key = scopeKey(scope);
  const [service, setService] = useServiceFilter(scope);
  const local = useQuery(async () => (desktop ? desktop.runs({ ...(service ? { project: service } : scopeFilter(scope)), limit: 100 }) : []), [desktop, key, service, tick]);
  const hub = useQuery(async () => (teamRuns ? client.call("runs.list", { ...(service ? { project: service } : scopeFilter(scope)), limit: 100 }) : []), [client, teamRuns, key, service, tick]);
  const groups = useQuery(async () => (teamRuns ? client.call("runs.groups", { ...(service ? { project: service } : scopeFilter(scope)), limit: 30 }) : []), [client, teamRuns, key, service, tick]);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  const machine = settings.data?.machine ?? null;

  // One subscription's runs, from its numbers on Agent và quota (roadmap 46): kept until cleared, the link goes.
  const [profileLink, clearProfileLink] = useHashParam("profile");
  const [profile, setProfile] = useState<string | null>(null);
  useEffect(() => {
    if (!profileLink) return;
    setProfile(profileLink);
    clearProfileLink();
  }, [profileLink, clearProfileLink]);

  const rows = useMemo(() => {
    const mine = new Set((local.data ?? []).map((r) => r.id));
    const ofProfile = (r: Row) => profile === null || r.run.profileId === profile;
    const localRows: Row[] = (local.data ?? []).map((run): Row => ({ src: "local", key: `local/${run.id}`, run })).filter(ofProfile);
    const remote = [...(hub.data ?? [])];
    if (linked.data && !remote.some(run => run.machineId === linked.data!.machineId && run.runId === linked.data!.runId)) remote.push(linked.data);
    const hubRows: Row[] = remote
      .filter((r) => !mine.has(r.runId))
      .map((run): Row => ({ src: "hub", key: `${run.machineId}/${run.runId}`, run }))
      .filter(ofProfile);
    const newest = (a: Row, b: Row) => rowTime(b).localeCompare(rowTime(a));
    return {
      here: localRows.filter((r) => isLive(r.run)).sort(newest),
      other: hubRows.filter((r) => isLive(r.run)).sort(newest),
      recent: [...localRows, ...hubRows].filter((r) => !isLive(r.run)).sort(newest).filter((r, i) => i < 60 || r.key === linkedRun),
    };
  }, [local.data, hub.data, linked.data, linkedRun, profile]);
  const all = useMemo(() => [...rows.here, ...rows.other, ...rows.recent], [rows]);
  useEffect(() => setActive(all.some((r) => isLive(r.run))), [all]);

  const [selected, setSelected] = useState<string | null>(null);
  const pick = (id: string | null) => {
    setSelected(id);
    if (mobileDetail.mobile) mobileDetail.navigate(id);
  };
  useEffect(() => {
    if (!mobileDetail.value) return;
    const found = all.find((r) => rowId(r) === mobileDetail.value || r.key === mobileDetail.value);
    if (found) {
      setSelected(found.key);
      if (!mobileDetail.mobile) mobileDetail.navigate(null, true);
    }
  }, [mobileDetail.value, mobileDetail.mobile, mobileDetail.navigate, all]);
  const latest = latestReviews((hub.data ?? []) as RunRecord[]);
  const loaded = !local.loading && !hub.loading;
  const counts = useMemo(() => {
    const n: Record<Filter, number> = { focus: 0, all: all.length, live: 0, waiting: 0, bad: 0, done: 0 };
    for (const r of all) {
      n[runGroup(r.run.status)]++;
      if (waitingReason(r.run)) n.waiting++;
      if (isLive(r.run) || waitingReason(r.run)) n.focus++;
    }
    return n;
  }, [all]);
  const kept = useMemo(() => {
    const group = (groups.data ?? []).find((g) => String(g.id) === groupFilter);
    const ids = group ? new Set(group.items.map((i) => i.run?.runId).filter(Boolean)) : null;
    const needle = query.trim().toLowerCase();
    const keep = (list: Row[]) => list.filter((r) => {
      if (taskFilter && r.run.taskId !== taskFilter) return false;
      if (machineFilter && (r.src === "hub" ? r.run.machineId : machine) !== machineFilter) return false;
      if (groupFilter && (!ids || !ids.has(rowId(r)))) return false;
      if (needle && ![r.run.taskId, r.run.taskTitle, r.run.profileId, r.src === "hub" ? r.run.machine : machine].join(" ").toLowerCase().includes(needle)) return false;
      if (filter === "focus") return isLive(r.run) || Boolean(waitingReason(r.run));
      if (filter === "waiting") return Boolean(waitingReason(r.run));
      return filter === "all" || runGroup(r.run.status) === filter;
    });
    return { here: keep(rows.here), other: keep(rows.other), recent: keep(rows.recent) };
  }, [rows, filter, taskFilter, machineFilter, groupFilter, groups.data, machine, query]);
  const shown = [...kept.here, ...kept.other, ...kept.recent];
  // A filter narrows the list, never what a link or a click may open: #run=… still finds a run the filter leaves out.
  const current = all.find((r) => r.key === (mobileDetail.mobile ? mobileDetail.value : selected) || (mobileDetail.mobile && rowId(r) === mobileDetail.value)) ?? (mobileDetail.mobile ? null : shown[0] ?? (filter === "all" ? all[0] : null) ?? null);

  let index = 0;
  useChatPageContext(current ? { id: rowId(current), href: `#/runs?run=${encodeURIComponent(current.src === "hub" ? `${current.run.machineId}/${current.run.runId}` : current.run.id)}`, project: current.run.project } : null);
  const liveRows = shown.filter((r) => isLive(r.run));
  const detail = current ? (
    current.src === "local" ? (
      <LocalDetail key={current.key} run={current.run} machine={machine ?? "—"} gitlabReady={Boolean((settings.data?.gitlab.url && settings.data.gitlab.hasToken) || settings.data?.github?.hasToken)} group={local.data ?? []} onChanged={local.reload} />
    ) : (
      <HubDetail key={current.key} run={current.run} latestReview={latest.has(current.key)} onChanged={hub.reload} />
    )
  ) : null;
  const tagOf = (id: Filter) => (
    <Tag key={id} role="button" tabIndex={0} active={filter === id} aria-pressed={filter === id} onClick={() => setFilter(id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(id); } }} className="cursor-pointer outline-none focus-visible:focus-ring">
      {t(`runs.filter.${id}`)} · {counts[id]}
    </Tag>
  );

  // Phone: the detail takes the page, as before. Desktop: the page stays and the detail is the design's right-hand drawer.
  if (mobileDetail.showingDetail) {
    return (
      <div className="mobile-master-detail flex h-full min-h-0 w-full flex-col bg-surface">
        <MobileBack onClick={() => pick(null)} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail ?? <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">{loaded ? t("runs.pick") : null}</div>}</div>
      </div>
    );
  }
  return (
    <div className="mobile-master-detail flex h-full min-h-0 w-full">
      <section className="runs-page" data-drawer={current && !mobileDetail.mobile ? "true" : undefined} aria-label={t("nav.runs")}>
        <p className="runs-sub">{t("runs.lead")}</p>
        <div className="mb-3 flex flex-col gap-2">
          <ServiceFilter scope={scope} value={service} onChange={setService} />
          <ErrorNote error={local.error ?? hub.error ?? linked.error} />
        </div>
        {liveRows.length ? (
          <>
            <div className="runs-live-title"><span className="runs-live-dot" aria-hidden="true" />{t("runs.liveNow", { count: liveRows.length })}</div>
            <div className="runs-live-grid" data-runs-live>
              {liveRows.map((r) => <RunCard key={r.key} row={r} on={r.key === current?.key} machine={machine} onPick={() => pick(r.key)} />)}
            </div>
          </>
        ) : null}
        {hubMode ? <div className="mb-3 max-h-[40dvh] overflow-y-auto"><MergeQueue project={service} /></div> : null}
        <div className="runs-filters">
          <span className="mr-2 text-[15px]/[22px] font-semibold">{t("runs.history")}</span>
          {(["focus", "all", "live", "bad", "waiting", "done"] as Filter[]).map(tagOf)}
          <span className="flex-1" />
          <Input className="runs-search h-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("runs.search")} aria-label={t("runs.search")} />
        </div>
        {teamRuns ? <details data-run-filters className="runs-more">
          <summary className="min-h-11 cursor-pointer content-center rounded-sm text-xs font-medium text-fg-secondary outline-none focus-visible:focus-ring md:min-h-8">{t("runs.moreFilters")}{[groupFilter, taskFilter, machineFilter].filter(Boolean).length ? ` (${[groupFilter, taskFilter, machineFilter].filter(Boolean).length})` : ""}</summary>
          <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
            <NativeSelect wrapperClassName="w-full min-w-0" className="w-full max-md:h-11 max-md:text-base" aria-label={t("runs.groupFilter")} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><NativeSelectOption value="">{t("runs.allGroups")}</NativeSelectOption>{(groups.data ?? []).map((g) => <NativeSelectOption key={g.id} value={String(g.id)}>{g.title || `#${g.id}`}</NativeSelectOption>)}</NativeSelect>
            <NativeSelect wrapperClassName="w-full min-w-0" className="w-full max-md:h-11 max-md:text-base" aria-label={t("runs.taskFilter")} value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}><NativeSelectOption value="">{t("runs.allTasks")}</NativeSelectOption>{[...new Map(all.map((r) => [r.run.taskId, r.run.taskTitle])).entries()].map(([id, title]) => <NativeSelectOption key={id} value={id}>{id} · {title}</NativeSelectOption>)}</NativeSelect>
            <NativeSelect wrapperClassName="w-full min-w-0" className="w-full max-md:h-11 max-md:text-base" aria-label={t("runs.machineFilter")} value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}><NativeSelectOption value="">{t("runs.allMachines")}</NativeSelectOption>{[...new Map((hub.data ?? []).map((r) => [r.machineId, r.machine])).entries()].map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}</NativeSelect>
          </div></details> : null}
        {groupFilter ? <a className="mb-3 block text-xs text-fg-link underline underline-offset-2" href={`#/runs?tab=batches&group=${encodeURIComponent(groupFilter)}`}>{t("runs.manageGroup")}</a> : null}
        {profile ? (
          <button
            type="button"
            data-profile-filter={profile}
            title={t("runs.profileFilterClear")}
            onClick={() => setProfile(null)}
            className="mb-3 flex h-[22px] w-fit cursor-pointer items-center gap-1 rounded-full border border-line-selected bg-selected px-2 text-[11px]/none font-medium text-selected-fg outline-none focus-visible:focus-ring"
          >
            {t("runs.profileFilter", { profile })}
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : null}
        <div className="runs-table">
          <div>
            <div className="runs-grid runs-head" aria-hidden="true">
              <span>{t("runs.col.status")}</span><span>{t("runs.col.task")}</span><span>{t("runs.col.job")}</span><span>{t("runs.col.agent")}</span><span>{t("runs.col.mr")}</span><span>{t("runs.col.time")}</span><span className="text-right">{t("runs.col.start")}</span>
            </div>
            <ul role="list" aria-label={t("nav.runs")} className="m-0 list-none p-0">
              {shown.map((r) => <RunRow key={r.key} row={r} index={index++} on={r.key === current?.key} machine={machine} onPick={() => pick(r.key)} />)}
            </ul>
            {loaded && !shown.length ? (
              <div className="runs-empty">{all.length || profile ? t("runs.noneFilter") : teamRuns ? t("runs.none") : t("runs.noneHere")}</div>
            ) : null}
          </div>
        </div>
      </section>
      {current && !mobileDetail.mobile ? (
        <>
          <div className="runs-scrim" onClick={() => pick(null)} aria-hidden="true" />
          <aside className="runs-drawer" role="dialog" aria-label={current.run.taskTitle} onKeyDown={(e) => { if (e.key === "Escape") pick(null); }}>
            <div className="runs-drawer-bar">
              <span className="runs-planet size-9" style={{ ["--planet" as string]: planetOf(current) }} aria-hidden="true" />
              <button type="button" className="runs-drawer-close" aria-label={t("common.close")} onClick={() => pick(null)}><X className="size-4" aria-hidden="true" /></button>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
          </aside>
        </>
      ) : null}
    </div>
  );
}


/** "bản 2/3 · được giữ", "giám khảo": a best-of-n run's place in its group. */
function bestOfText(run: AgentRun, t: TFunction): string | null {
  const b = run.bestOf;
  if (!b) return null;
  if (b.n === 0) return t("board.judge");
  const kept = b.pick === null ? "" : ` · ${b.pick === b.n ? t("board.kept") : t("board.notKept")}`;
  return `${t("board.candidateOf", { n: b.n, of: b.of })}${kept}`;
}

const kindOf = (r: Row): string | null => (r.src === "hub" ? r.run.kind : r.run.agentKind) ?? null;
/** The planet image stands for the agent's CLI: claude violet, codex green, gemini blue (the design's avatars). */
const planetOf = (r: Row): string => `url("${{ codex: cosmicAssets.planetGreen, gemini: cosmicAssets.planetBlue }[kindOf(r) ?? ""] ?? cosmicAssets.planetViolet}")`;
const hhmm = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
const mrOf = (r: Row): string => {
  const url = r.run.mrUrl;
  if (!url) return "—";
  const iid = r.src === "hub" ? r.run.mr?.iid ?? null : r.run.mrIid;
  return mrLabel({ mrUrl: url, iid }).replace(/^MR /, "").replace(/^PR /, "");
};
/** Design tones: a running review shows as "Review chéo" in violet, the rest by status. */
function toneOf(r: AgentRun | RunRecord): string {
  if (r.status === "running" && r.role.startsWith("review")) return "review";
  return { running: "running", queued: "queued", succeeded: "success", failed: "danger", rate_limited: "warning" }[r.status] ?? "neutral";
}
const statusText = (r: AgentRun | RunRecord) => (r.status === "running" && r.role.startsWith("review") ? runLabel("agentRole", r.role) : runLabel("runStatus", r.status));

/** A live run as a card: who runs it, which task, and an indeterminate track (the list has no step count to show). */
function RunCard({ row, on, machine, onPick }: { row: Row; on: boolean; machine: string | null; onPick: () => void }) {
  const t = useT();
  const r = row.run;
  const tone = toneOf(r);
  const where = row.src === "hub" ? row.run.machine : machine;
  return (
    <button type="button" className="runs-card" data-tone={tone} data-run-card={r.status} aria-current={on ? "true" : undefined} onClick={onPick}>
      <span className="flex items-center gap-2.5">
        <span className="runs-planet size-[30px]" style={{ ["--planet" as string]: planetOf(row) }} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px]/[18px] font-semibold">{r.profileId ?? t("board.waitingProfile")}</span>
          <span className="runs-ellipsis text-xs/4 text-fg-muted">{where ?? "—"}</span>
        </span>
        <span className="runs-pill text-[11px]/none font-semibold"><i />{statusText(r)}</span>
      </span>
      <span className="flex flex-col gap-[3px]">
        <span className="runs-mono text-[11.5px]/none font-semibold text-fg-muted">{r.taskId}</span>
        <span className="text-sm/5 font-semibold text-pretty">{r.taskTitle}</span>
      </span>
      <span className="flex flex-col gap-1.5">
        <span className="flex text-xs/4 text-fg-secondary"><span className="flex-1">{waitingReason(r) ? t("runs.waiting") : r.activity ?? runLabel("agentRole", r.role)}</span><span className="text-fg-muted">{runDuration(r)}</span></span>
        <span className="runs-track" aria-hidden="true" data-still={r.status === "queued"}><span /></span>
      </span>
    </button>
  );
}

/** One run in the table: status, task, the job, agent · machine, MR, how long, when it started. */
function RunRow({ row, index, on, machine, onPick }: { row: Row; index: number; on: boolean; machine: string | null; onPick: () => void }) {
  const t = useT();
  const r = row.run;
  const mr = mrOf(row);
  const where = row.src === "hub" ? row.run.machine : machine;
  return (
    <li>
      <button
        type="button"
        data-pane-item
        aria-current={on ? "true" : undefined}
        data-run-index={index}
        data-run-status={r.status}
        data-best={row.src === "local" && row.run.bestOf ? (row.run.bestOf.n === 0 ? "judge" : row.run.bestOf.pick === row.run.bestOf.n ? "kept" : "candidate") : undefined}
        data-tone={toneOf(r)}
        onClick={onPick}
        className="runs-grid runs-row"
      >
        <span className="runs-pill"><i />{statusText(r)}</span>
        <span className="flex min-w-0 items-baseline gap-2.5 max-md:col-span-2">
          <span className="runs-mono shrink-0 text-[11.5px]/none font-semibold text-fg-muted">{r.taskId}</span>
          <span className="runs-ellipsis text-[13.5px]/[19px] font-semibold">{r.taskTitle}</span>
        </span>
        <span data-run-service={r.project} className="runs-ellipsis text-xs/4 text-fg-secondary max-md:col-span-2" title={[runOutcome(r), bestOfText(row.run as AgentRun, t)].filter(Boolean).join(" · ")}>
          {[runLabel("agentRole", r.role), row.src === "local" ? bestOfText(row.run, t) : null].filter(Boolean).join(" · ")}
          <span className="sr-only"> {t("systemOverview.service")}: {r.project}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="runs-planet size-5" style={{ ["--planet" as string]: planetOf(row) }} aria-hidden="true" />
          <span className="flex min-w-0 flex-col">
            <span className="runs-ellipsis text-[12.5px]/4 font-semibold">{r.profileId ?? t("board.waitingProfile")}</span>
            <span className="runs-ellipsis text-[11px]/[15px] font-medium text-fg-muted">{where ?? "—"}</span>
          </span>
        </span>
        <span className="runs-mr" data-none={mr === "—"}>{mr}</span>
        <span className="text-xs/4 text-fg-secondary">{runDuration(r) || "—"}</span>
        <span className="runs-mono text-right text-xs/none font-medium text-fg-muted">{hhmm(r.startedAt ?? r.createdAt)}</span>
      </button>
    </li>
  );
}

function stateLabel(run: { status: string; startedAt: string | null; finishedAt: string | null }, t: TFunction): string {
  const time = runDuration(run);
  const state = runLabel("runStatus", run.status);
  return time ? t("runs.stateTime", { state, time }) : state;
}

/** Header of a run's detail (the design's drawer): state · time, task · title, job · plan · machine, a summary line, and the buttons the state calls for. */
function Head({ run, machine, actions, below }: { run: AgentRun | RunRecord; machine: string; actions: ReactNode; below?: ReactNode }) {
  const t = useT();
  const id = "id" in run ? run.id : run.runId;
  const waiting = waitingReason(run);
  const tone = toneOf(run);
  const time = runDuration(run);
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-line-subtle px-5 pt-3 pb-4" data-run-heading>
      <div className="flex flex-wrap items-center gap-2">
        <span className="runs-pill" data-tone={tone}>
          <i aria-hidden="true" />
          <span aria-hidden="true">{time ? t("runs.stateTime", { state: statusText(run), time }) : statusText(run)}</span>
          {/* Elapsed time changes on each poll; announce only the meaningful state transition. */}
          <span data-run-state role="status" aria-atomic="true" className="sr-only">{t("runs.stateAnnouncement", { task: run.taskTitle, state: runLabel("runStatus", run.status) })}</span>
        </span>
        <ModelRunChip run={run} />
        {waiting ? <Chip kind="warning">{t("runs.waiting")}</Chip> : null}
        <span className="runs-mono ml-auto text-[11px]/4 text-fg-muted">{id}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="runs-mono text-[12px] font-semibold text-fg-muted">{run.taskId}</span>
        <h2 className="m-0 font-display text-[17px]/6 font-semibold text-fg-strong">{run.taskTitle}</h2>
        <span className="break-words text-xs/4 text-fg-muted">
          {[runLabel("agentRole", run.role), run.profileId ?? t("board.waitingProfile"), machine, run.project, run.branch ? t("runs.worktree", { branch: run.branch }) : null].filter(Boolean).join(" · ")}
        </span>
        {run.headSha ? <span className="break-all font-mono text-xs text-fg-secondary" data-run-head-sha>{t("runs.codeRevision", { sha: run.headSha })}</span> : null}
      </div>
      {run.summary ? <p className="m-0 line-clamp-3 text-[13px]/5 text-fg-secondary">{run.summary}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5 max-md:gap-2">
        {actions}
        <RunRoles run={run} />
      </div>
      {below}
    </div>
  );
}

/** Tóm tắt / Log / Thay đổi. Plain buttons: the screenshot harness clicks them, and a tab is the whole of the pane. */
function TabBar({ tabs, tab, onTab, right, panelId }: { tabs: Array<[string, string]>; tab: string; onTab: (k: string) => void; right?: ReactNode; panelId?: string }) {
  return (
    <div role="tablist" className="flex min-h-[34px] flex-wrap max-md:min-h-11 shrink-0 items-center gap-0.5 border-b border-line-subtle bg-subtle pr-2 pl-3">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="tab"
          data-run-tab={k}
          id={panelId ? `${panelId}-${k}` : undefined}
          aria-controls={panelId}
          aria-selected={tab === k}
          tabIndex={tab === k ? 0 : -1}
          onKeyDown={event => {
            const at = tabs.findIndex(([key]) => key === k);
            const next = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            onTab(tabs[next]![0]);
            (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
          }}
          onClick={() => onTab(k)}
          className={cn(
            "h-[34px] max-md:h-11 cursor-pointer border-b-2 px-2.5 text-xs/none font-semibold outline-none focus-visible:focus-ring",
            tab === k ? "border-primary text-fg-strong" : "border-transparent text-fg-muted",
          )}
        >
          {label}
        </button>
      ))}
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** The tab the detail opens on: what the agent answered, where the run got to, the MR, then the rest. */
function SummaryPane({ summary, live, head, children }: { summary: string | null; live: boolean; head: string[]; children: ReactNode }) {
  const t = useT();
  const handoff = handoffSections(summary);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-[760px] flex-col gap-3 px-5 pt-4 pb-6">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">{t("runs.summary")}</span>
          {handoff.length ? (
            <div className="grid gap-2" data-run-handoff>
              {handoff.map((part) => <section key={part.id} className="rounded-md border border-line-subtle bg-subtle p-3">
                <h3 className="m-0 text-xs font-semibold text-fg-strong">{t(`runs.handoff.${part.id}`)}</h3>
                <p className="mt-1 mb-0 text-[13px]/5 whitespace-pre-wrap text-fg-primary [overflow-wrap:anywhere]"><ArtifactText text={part.text || "—"} /></p>
              </section>)}
            </div>
          ) : summary ? (
            <p className="m-0 text-[13px]/5 whitespace-pre-wrap text-fg-primary [overflow-wrap:anywhere]"><ArtifactText text={summary} /></p>
          ) : (
            <p className="m-0 text-[13px]/5 text-fg-muted">{live ? t("runs.summaryLive") : t("runs.summaryNone")}</p>
          )}
        </div>
        {children}
        {head.length ? (
          <details className="rounded-md border border-line-subtle bg-subtle px-3 py-2">
            <summary data-run-tech className="cursor-pointer text-[13px]/5 text-fg-muted select-none">
              {t("runs.tech")}
            </summary>
            <pre className="mt-2 mb-0 overflow-auto rounded-md border border-line-subtle bg-code p-2 font-mono text-xs/5 whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere]">{head.join("\n")}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** A completed run can start another chain on its task; live runs still hold the branch. */
function RunRoles({ run }: { run: AgentRun | RunRecord }) {
  const { client, me } = useHive();
  const allow = useCan();
  const t = useT();
  const [open, setOpen] = useState(false);
  const enabled = me.mode === "hub" && allow(run.project, "runDispatch");
  const tasks = useQuery(async () => enabled ? client.call("tasks.list", { project: run.project }) : [], [client, run.project, enabled]);
  const task = tasks.data?.find((task) => task.id === run.taskId && task.status !== "done");
  if (!enabled || !task) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="max-md:min-h-11"
        disabled={isLive(run)}
        title={isLive(run) ? t("tasks.rolesWaitRun") : undefined}
        data-run-roles-open
        onClick={() => setOpen(true)}
      >
        {t("tasks.rolesOpen")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <RolesSheet
          task={task}
          initialMachineId={"machineId" in run ? run.machineId : undefined}
          onSent={(id) => {
            setOpen(false);
            window.location.hash = `/runs?tab=batches&group=${id}`;
          }}
        />
      </Sheet>
    </>
  );
}

const LEVEL_CLS: Record<LogLevel, string> = {
  human: "text-fg-brand",
  tool: "text-fg-brand",
  ok: "text-success",
  error: "text-danger",
  agent: "text-fg-muted",
  meta: "text-fg-muted",
  section: "text-fg-strong",
};

/**
 * The log by level (TOOL / OK / LỖI / AGENT); the prompt folds away, the view follows a live run. The runner's own
 * header (# profile, # policy…) is not here: the summary keeps it under *Chi tiết kỹ thuật*.
 */
function LogView({ text, live, wrap, empty }: { text: string; live: boolean; wrap: boolean; empty: string }) {
  const t = useT();
  const lines = useMemo(() => {
    const parsed = parseLog(text);
    return parsed.slice(logHeader(parsed).length);
  }, [text]);
  const [promptOpen, setPromptOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    const el = box.current;
    if (!el || !text) return;
    if (live || !opened.current) el.scrollTop = el.scrollHeight;
    opened.current = true;
  }, [text, live]);
  const promptCount = lines.filter((l) => l.section === "Prompt" && l.level !== "section").length;
  // A log the runner stamped gets a column with the time of each line (older logs have none).
  const timed = lines.some((l) => l.at);
  const clock = (at: string) => new Date(at).toLocaleTimeString(activeIntl(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return (
    <div ref={box} role="log" aria-live={live ? "polite" : undefined} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs/5">
      {!text ? <div className="px-3.5 text-fg-muted">{empty}</div> : null}
      {lines.map((l, i) => {
        if (l.section === "Prompt" && l.level !== "section" && !promptOpen) return null;
        if (l.level === "section") {
          const isPrompt = l.text === "Prompt";
          return (
            <button
              key={i}
              type="button"
              disabled={!isPrompt}
              onClick={() => setPromptOpen((v) => !v)}
              className={cn("mt-1.5 flex w-full px-3.5 py-0.5 text-left font-semibold text-fg-strong", isPrompt && "cursor-pointer hover:bg-hover")}
            >
              {isPrompt ? `${promptOpen ? "▾" : "▸"} ${t("runs.prompt", { count: promptCount })}` : `## ${l.text}`}
            </button>
          );
        }
        return (
          <div key={i} className={cn("flex gap-3 px-3.5", l.level === "error" && "bg-danger-soft")}>
            {timed ? (
              <span title={l.at ?? undefined} className="w-[58px] shrink-0 text-fg-muted tabular-nums">
                {l.at && (i === 0 || lines[i - 1]!.at !== l.at) ? clock(l.at) : ""}
              </span>
            ) : null}
            <span className={cn("w-[76px] shrink-0 font-semibold", LEVEL_CLS[l.level])}>{l.level === "agent" && !l.text ? "" : t(`runs.level.${l.level}`)}</span>
            <span className={cn("min-w-0", l.level === "error" ? "text-danger" : l.level === "tool" ? "text-code-fg" : l.level === "meta" ? "text-fg-muted" : "text-fg-strong", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
              {l.text || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The run's steps (Đọc context → Viết code → Chạy test → Tạo MR, or a review's), from what its log shows. */
function Steps({ run, log }: { run: AgentRun | RunRecord; log: string }) {
  const t = useT();
  const lines = useMemo(() => parseLog(log), [log]);
  const steps = runSteps(run.role, lines, run.status);
  const clock = (at: string) => new Date(at).toLocaleTimeString(activeIntl(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <ol aria-label={t("runs.steps")} className="m-0 flex shrink-0 list-none items-center gap-1.5 overflow-x-auto p-0">
      {steps.map((s, i) => (
        <li key={s.id} className="flex shrink-0 items-center gap-1.5" aria-current={s.state === "current" ? "step" : undefined}>
          <span
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium",
              s.state === "done" && "border-success-line bg-success-soft text-fg-strong",
              s.state === "current" && "border-running-line bg-running-soft text-fg-strong",
              s.state === "failed" && "border-danger-line bg-danger-soft text-danger",
              s.state === "todo" && "border-line-default text-fg-muted",
            )}
            title={s.at ? clock(s.at) : undefined}
          >
            <span
              className={cn(
                "grid size-4 place-items-center rounded-full text-[10px] font-bold",
                s.state === "done" && "bg-success-solid text-white",
                s.state === "current" && "bg-running text-white",
                s.state === "failed" && "bg-danger-solid text-white",
                s.state === "todo" && "bg-sunken text-fg-muted",
              )}
            >
              {s.state === "done" ? "✓" : s.state === "failed" ? "✗" : s.state === "current" ? "●" : i + 1}
            </span>
            {t(`runs.step.${s.id}`)}
            {s.at && s.state !== "todo" ? <span className="font-mono text-[10px] text-fg-muted">{clock(s.at)}</span> : null}
          </span>
          {i < steps.length - 1 ? <span className={cn("h-px w-4", i < steps.findIndex((x) => x.state !== "done") || steps.every((x) => x.state === "done") ? "bg-success" : "bg-line-default")} /> : null}
        </li>
      ))}
    </ol>
  );
}

function DiffView({ files, error, review, fix }: { files: DiffFile[] | null; error: string | null; review?: DiffReview | null; fix?: DiffFixTarget }) {
  const t = useT();
  if (error) return <div className="p-3.5 text-[13px] text-danger">{error}</div>;
  if (!files) return null;
  if (!files.length) return <div className="p-3.5 text-[13px] text-fg-muted">{t("runs.noDiff")}</div>;
  return <div className="min-h-0 flex-1 overflow-auto bg-surface"><RunDiff files={files} review={review} fix={fix} /></div>;
}

/**
 * What the run did, in three tabs. It opens on *Tóm tắt* — the agent's last words, the steps, the MR — so reading a
 * run no longer starts with a terminal; the log and the changes are one click away (roadmap 39e).
 */
function RunPanes({
  summary,
  artifacts,
  live,
  log,
  logEmpty,
  steps,
  notes,
  diff,
  diffError,
  diffReview,
  diffFix,
  onDiffTab,
  footer,
}: {
  summary: string | null;
  artifacts?: ReactNode;
  live: boolean;
  log: string;
  /** Why there is no log, when it is not "the machine sent none": an old run the hub cleaned up (roadmap 41b). */
  logEmpty?: string | null;
  steps: ReactNode;
  notes: ReactNode;
  diff?: DiffFile[] | null;
  diffError?: string | null;
  diffReview?: DiffReview | null;
  diffFix?: DiffFixTarget;
  onDiffTab?: () => void;
  footer?: ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const [tab, setTab] = useState("summary");
  const panelId = useId();
  const [wrap, setWrap] = useState(true);
  const head = useMemo(() => logHeader(parseLog(log)), [log]);
  const tabs: Array<[string, string]> = [
    ["summary", t("runs.tabSummary")],
    ["log", t("runs.tabLog")],
  ];
  if (onDiffTab) tabs.push(["diff", t("runs.tabDiff", { count: diff?.length ?? "…" })]);
  return (
    <div data-run-review className={cn("flex min-h-0 flex-1 flex-col", tab === "summary" ? "bg-surface" : "bg-code")}>
      <TabBar
        panelId={panelId}
        tabs={tabs}
        tab={tab}
        onTab={(k) => {
          setTab(k);
          if (k === "diff") onDiffTab?.();
        }}
        right={
          tab === "log" ? (
            <>
              <button
                type="button"
                aria-pressed={wrap}
                onClick={() => setWrap((w) => !w)}
                className={cn("h-6 max-md:h-11 cursor-pointer rounded-[5px] px-2 text-[11px]/none font-medium text-fg-secondary outline-none focus-visible:focus-ring", wrap ? "bg-selected" : "hover:bg-hover")}
              >
                {t("runs.wrap")}
              </button>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(log).then(() => toast(t("runs.copied")), () => undefined)}
                className="h-6 max-md:h-11 cursor-pointer rounded-[5px] px-2 text-[11px]/none font-medium text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
              >
                {t("runs.copyLog")}
              </button>
            </>
          ) : null
        }
      />
      <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`} className="flex min-h-0 flex-1 flex-col overflow-auto max-md:[&_button]:min-h-11 max-md:[&_summary]:min-h-11 max-md:[&_summary]:content-center">
      {tab === "summary" ? (
        <SummaryPane summary={summary} live={live} head={head}>
          {artifacts}
          {steps}
          <div className="flex flex-col gap-2">{notes}</div>
          {footer}
        </SummaryPane>
      ) : tab === "log" ? (
        <LogView text={log} live={live} wrap={wrap} empty={live ? t("board.waitingOutput") : (logEmpty ?? t("board.noLog"))} />
      ) : (
        <DiffView files={diff ?? null} error={diffError ?? null} review={diffReview} fix={diffFix} />
      )}
      </div>
    </div>
  );
}

function NoteLine({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "info" | "danger" }) {
  return <div className={cn("text-xs/[18px] [overflow-wrap:anywhere]", tone === "info" ? "text-info" : tone === "danger" ? "text-danger" : "text-fg-muted")}>{children}</div>;
}

function SteerForm({ send, local = false, onChanged }: { send: (text: string) => Promise<unknown>; local?: boolean; onChanged: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const action = useAction();
  return <form data-run-steer className="space-y-2" aria-busy={action.busy} onSubmit={(e) => {
    e.preventDefault();
    if (action.busy || !text.trim()) return;
    void action.run(async () => {
      await send(text.trim());
      setText("");
      setStatus(t(local ? "runs.steerDelivered" : "runs.steerQueued"));
      onChanged();
    });
  }}>
    <label className="block text-sm font-medium" htmlFor="run-steer-text">{t("runs.steerLabel")}</label>
    <Textarea id="run-steer-text" aria-describedby="run-steer-hint run-steer-error" aria-invalid={!!action.error} maxLength={8000} value={text} disabled={action.busy} onChange={(e) => { setText(e.target.value); setStatus(""); }} className="text-base md:text-sm" />
    <p id="run-steer-hint" className="text-xs text-fg-muted">{t(local ? "runs.steerLocalHint" : "runs.steerHint")}</p>
    <Button type="submit" className="min-h-11" disabled={action.busy || !text.trim()}>{t(action.busy ? "runs.steerSending" : "runs.steerSend")}</Button>
    <p role="status" className="text-xs text-fg-muted">{status}</p>
    <div id="run-steer-error"><ErrorNote error={action.error} /></div>
  </form>;
}

function SteerHistory({ messages, ended = false }: { messages: RunMessage[]; ended?: boolean }) {
  const t = useT();
  if (!messages.length) return null;
  return <section data-run-messages aria-label={t("runs.steerHistory")} className="space-y-2 text-xs">
    {messages.map((m) => <div data-run-message key={m.id} className="border-l-2 border-line-control pl-3 [overflow-wrap:anywhere]">
      <p className="text-fg-muted">{t("runs.level.human")} · {m.by} · {formatTime(m.at)} · {t(m.deliveredAt ? "runs.steerDelivered" : ended ? "runs.steerUndelivered" : "runs.steerPending")}</p>
      <p className="whitespace-pre-wrap">{m.text}</p>
    </div>)}
  </section>;
}

/** A run on this machine: full log, changes, and what the Board used to offer (stop, MR, worktree, best-of pick). */
function LocalDetail({ run, machine, gitlabReady, group, onChanged }: { run: AgentRun; machine: string; gitlabReady: boolean; group: AgentRun[]; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const desktop = client.desktop!;
  const live = isLive(run);
  const tick = useRefresh(live);
  const log = useQuery(() => desktop.runLog(run.id), [desktop, run.id, tick, run.status]);
  const messages = useQuery(() => desktop.runMessages(run.id), [desktop, run.id, tick, run.status]);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const action = useAction();
  const b = run.bestOf;
  const peers = b ? group.filter((r) => r.bestOf?.group === b.group) : [];
  // Nothing of the group left to run and nothing kept: the judge chose none, so a person keeps one.
  const undecided = b !== null && b.pick === null && peers.some((r) => r.bestOf!.n > 0 && r.status === "succeeded") && !peers.some(isLive);
  const loadDiff = () => {
    if (diff) return;
    desktop.runDiff(run.id).then(
      (p) => setDiff(parsePatch(p)),
      (err: unknown) => setDiffError(errorMessage(err) || t("runs.diffError")),
    );
  };
  const mr = run.mrUrl ? mrLabel({ mrUrl: run.mrUrl, iid: run.mrIid }) : null;

  // The one button the run's state calls for comes first and filled: stop it, open its MR, or run it again.
  const actions = (
    <>
      <TerminalEntry source="run" project={run.project} checkoutRef={run.worktree ? `worktree:${run.taskId}` : "repo"} runActive={live} />
      {live ? (
        <Button
          size="sm"
          variant="danger-outline"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await desktop.cancelRun(run.id);
              toast(t("runs.cancelLocalDone", { id: run.id }));
              onChanged();
            })
          }
        >
          {t("runs.cancelLocal")}
        </Button>
      ) : null}
      {!live && run.mrUrl ? (
        <Button size="sm" asChild>
          <a href={run.mrUrl} target="_blank" rel="noreferrer" title={run.mrNote ?? run.mrUrl}>
            {t("runs.openMr", { mr: mr! })}
          </a>
        </Button>
      ) : null}
      {!live && !b ? (
        <Button
          size="sm"
          variant={run.mrUrl ? "outline" : "default"}
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await desktop.startRun({ project: run.project, taskId: run.taskId, role: run.role, profileId: run.profileId, instructions: run.instructions, reviewAfter: run.reviewAfter });
              toast(t("runs.rerunDone", { task: run.taskId }));
              onChanged();
            })
          }
        >
          {t("runs.rerun")}
        </Button>
      ) : null}
      {undecided && b!.n > 0 && run.status === "succeeded" ? (
        <Button
          size="sm"
          disabled={action.busy}
          onClick={() => {
            if (window.confirm(t("board.confirmPick", { n: b!.n, task: run.taskId }))) void action.run(async () => (await desktop.pickCandidate(run.id), onChanged()));
          }}
        >
          {t("board.pickThis")}
        </Button>
      ) : null}
      {gitlabReady && run.status === "succeeded" && run.role !== "plan" && run.commits > 0 && (!b || b.pick === b.n) ? (
        <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => (await desktop.createMergeRequest(run.id), onChanged()))}>
          {run.mrUrl ? t("board.updateMr") : t("board.createMr")}
        </Button>
      ) : null}
      {run.worktree ? (
        <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(() => desktop.showInFolder(run.worktree!))}>
          {t("board.openWorktree")}
        </Button>
      ) : null}
      {run.worktree && !live ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={action.busy}
          onClick={() => {
            if (window.confirm(t("board.confirmRemoveWorktree"))) void action.run(async () => (await desktop.removeWorktree(run.id), onChanged()));
          }}
        >
          {t("board.removeWorktree")}
        </Button>
      ) : null}
    </>
  );

  const notes = (
    <>
      {run.activity ? <NoteLine tone="info">{t("board.activity", { activity: run.activity })}</NoteLine> : null}
      {run.branch ? (
        <NoteLine>
          <span className="font-mono">
            {run.branch} · {t("board.commits", { count: run.commits })}
            {run.headSha ? ` · ${run.headSha}` : ""}
          </span>
          {run.costUsd !== null ? ` · ${t("board.cost", { cost: formatUsd(run.costUsd) })}` : ""}
        </NoteLine>
      ) : null}
      {run.outputTokens !== null ? <TokensLine tokens={run} /> : null}
      {run.compression ? <CompressionLine compression={run.compression} /> : null}
      {b ? (
        <NoteLine>
          {b.n === 0 ? t("board.judgeDetail", { of: b.of }) : t("board.bestOfDetail", { n: b.n, of: b.of })}
          {b.pick ? ` · ${t("board.keptReason", { n: b.pick, reason: b.reason ?? "" })}` : ""}
          {undecided ? ` · ${t("board.undecided")}` : ""}
        </NoteLine>
      ) : null}
      {run.ciFix ? (
        <NoteLine>
          <a className="font-medium text-fg-link underline underline-offset-2" href={run.ciFix.pipelineUrl ?? run.ciFix.mrUrl} target="_blank" rel="noreferrer">
            {t("board.ciFixOf", { mr: mrLabel({ mrUrl: run.ciFix.mrUrl, iid: run.ciFix.mrIid }), n: run.ciFix.n, max: run.ciFix.max })}
          </a>{" "}
          · {run.ciFix.jobs.length ? t("board.ciFixJobs", { jobs: run.ciFix.jobs.map((j) => `${j.name} (${j.stage})`).join(", ") }) : t("board.ciFixNoJobs")}
        </NoteLine>
      ) : null}
      {run.mrUrl ? (
        <NoteLine>
          <a className="font-medium text-fg-link underline underline-offset-2" href={run.mrUrl} target="_blank" rel="noreferrer" title={run.mrNote ?? run.mrUrl}>
            {mr}
          </a>
          {run.mrStatus && run.mrCheckedAt ? ` · ${t("board.mrOnGitLab", { status: t(`mrStatus.${run.mrStatus}`), time: formatTime(run.mrCheckedAt) })}` : ""}
          {run.pipelineStatus ? ` · ${t("board.pipeline", { status: t(`pipelineStatus.${run.pipelineStatus}`) })}` : ""}
        </NoteLine>
      ) : run.mrNote ? (
        <NoteLine tone={run.mrState === "failed" ? "danger" : "muted"}>{run.mrNote}</NoteLine>
      ) : null}
      {run.error ? <Notice tone={run.status === "queued" ? "info" : "warn"} className="[overflow-wrap:anywhere]">{run.error}</Notice> : null}
      <SteerHistory messages={messages.data ?? []} />
      {run.status === "running" ? <SteerForm key={run.id} local send={(text) => desktop.steerRun(run.id, text)} onChanged={() => { messages.reload(); log.reload(); onChanged(); }} /> : null}
      <ErrorNote error={action.error} />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Head run={run} machine={machine} actions={actions} />
      <RunPanes
        summary={run.summary}
        live={live}
        log={log.data ?? ""}
        steps={<Steps run={run} log={log.data ?? ""} />}
        notes={notes}
        diff={diff}
        diffReview={run.diffReview}
        diffError={diffError}
        onDiffTab={loadDiff}
      />
    </div>
  );
}

/** A run another machine pushed to the hub: the end of its log, stop, and a fix run for a review that asks for one. */
export function HubDetail({ run, latestReview, onChanged }: { run: RunRecord; latestReview: boolean; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const live = isLive(run);
  // What a finished review concluded, as its report says (the same reading as the MR a machine opens).
  // The stored one was read from the whole report (54a); a run from an older app has only the clipped summary.
  const verdict = run.role === "review" && run.status === "succeeded" ? (run.verdict ?? parseVerdict(run.summary)) : "none";
  const tick = useRefresh(live);
  const full = useQuery(() => client.call("runs.get", { machineId: run.machineId, runId: run.runId }), [client, run.machineId, run.runId, tick]);
  const files = useArtifacts(run.project, undefined, run.runId, run.machineId, run.updatedAt);
  const manage = allow(run.project, "runDispatch");
  // A queued run still waiting for its machine is a pending request: cancelling that is "Huỷ yêu cầu".
  const requests = useQuery(() => (run.status === "queued" ? client.call("runs.requests", { project: run.project, taskId: run.taskId, pendingOnly: true, limit: 20 }) : Promise.resolve([])), [client, run.project, run.taskId, run.status, tick]);
  const pendingRequest = (requests.data ?? []).find((r) => r.machineId === run.machineId && r.status === "pending") ?? null;
  const patchFiles = useMemo(() => (full.data?.patch ? parsePatch(full.data.patch) : []), [full.data?.patch]);
  // An old run the hub cleaned up (roadmap 41b): the log and the diff are gone, what it concluded is not.
  const pruned = run.logPrunedAt ? t("runs.logPruned", { time: formatTime(run.logPrunedAt) }) : null;

  // The one button the run's state calls for: stop it while it runs, open its MR once it is done.
  const actions = (
    <>
      <TerminalEntry source="run" machineId={run.machineId} project={run.project} checkoutRef={run.branch?.startsWith("ai/") ? `worktree:${run.taskId}` : "repo"} runActive={live} />
      {live && !run.cancelRequestedBy && manage ? (
        <Button
          size="sm"
          variant="danger-outline"
          disabled={action.busy}
          title={t("runs.cancelHint")}
          onClick={() =>
            void action.run(async () => {
              await client.call("runs.cancel", { machineId: run.machineId, runId: run.runId });
              onChanged();
            })
          }
        >
          {t("runs.cancel")}
        </Button>
      ) : null}
      {pendingRequest && manage ? (
        <Button size="sm" variant="danger-outline" disabled={action.busy} onClick={() => void action.run(async () => { await client.call("runs.cancelRequest", { id: pendingRequest.id }); onChanged(); })}>
          {t("runs.cancelPending")}
        </Button>
      ) : null}
      {live && !manage ? <span className="text-xs/7 text-fg-muted">{t("runs.onlyView", { machine: run.machine })}</span> : null}
      {!live && run.mrUrl ? (
        <Button size="sm" asChild>
          <a href={run.mrUrl} target="_blank" rel="noreferrer" title={run.mrUrl}>
            {t("runs.openMr", { mr: mrLabel({ mrUrl: run.mrUrl, iid: run.mr?.iid ?? null }) })}
          </a>
        </Button>
      ) : null}
    </>
  );

  const notes = (
    <>
      {verdict === "approve" || verdict === "changes" ? <NoteLine tone={verdict === "approve" ? "info" : "danger"}>{t(`runs.verdict.${verdict}`)}</NoteLine> : null}
      {run.activity ? <NoteLine tone="info">{t("board.activity", { activity: run.activity })}</NoteLine> : null}
      {run.branch || run.costUsd !== null ? (
        <NoteLine>
          {run.branch ? <span className="font-mono">{`${run.branch} · ${t("board.commits", { count: run.commits })}`}</span> : null}
          {run.costUsd !== null ? `${run.branch ? " · " : ""}${t("board.cost", { cost: formatUsd(run.costUsd) })}` : ""}
        </NoteLine>
      ) : null}
      {run.tokens ? <TokensLine tokens={run.tokens} /> : null}
      {run.compression ? <CompressionLine compression={run.compression} /> : null}
      {live && run.cancelRequestedBy ? <Notice tone="warn">{t("runs.cancelRequested", { who: run.cancelRequestedBy, time: formatTime(run.cancelRequestedAt) })}</Notice> : null}
      {run.error ? <Notice tone={run.status === "queued" ? "info" : "warn"} className="[overflow-wrap:anywhere]">{run.error}</Notice> : null}
      <SteerHistory messages={full.data?.messages ?? []} ended={!live} />
      {run.status === "running" && manage ? <SteerForm key={`${run.machineId}:${run.runId}`} send={(text) => client.call("runs.steer", { machineId: run.machineId, runId: run.runId, text })} onChanged={() => { full.reload(); onChanged(); }} /> : null}
      <ErrorNote error={action.error ?? full.error} />
      <NoteLine>{pruned ?? t("runs.logNote", { time: formatTime(run.updatedAt) })}</NoteLine>
    </>
  );

  return (
    <ArtifactContext.Provider value={files.data ?? []}>
    <div className="flex min-h-0 flex-1 flex-col">
      <Head run={run} machine={run.machine} actions={actions} below={<RunRedispatch key={`${run.machineId}/${run.runId}`} split run={run} onSent={onChanged} />} />
      {/* What it changed, as its machine sent it; a hub older than 22l has no patches (no tab). */}
      <RunPanes
        artifacts={files.data?.length || files.error || files.loading ? <ArtifactRows files={files.data ?? []} error={files.error} loading={files.loading} onChanged={files.reload} context={run.runId} /> : null}
        diffReview={full.data?.diffReview}
        diffFix={!live && run.status === "succeeded" && run.role === "implement" && manage ? { machineId: run.machineId, project: run.project, taskId: run.taskId } : undefined}
        footer={<>{run.mrUrl ? <MrMerge run={run} onChanged={onChanged} /> : null}{verdict === "changes" && latestReview && manage ? <FixRun run={run} /> : null}</>}
        summary={run.summary}
        live={live}
        log={full.data?.log ?? ""}
        logEmpty={pruned}
        steps={<Steps run={run} log={full.data?.log ?? ""} />}
        notes={notes}
        {...(full.data && full.data.patch !== undefined
          ? {
              diff: full.data.patch ? patchFiles : full.data.patch === "" ? [] : null,
              // A dropped diff is not a diff the machine never sent: say which it is (roadmap 41b).
              diffError: full.data.patch !== null ? null : (pruned ?? t("runs.patchNotSent", { machine: run.machine })),
              onDiffTab: () => undefined,
            }
          : {})}
      />
    </div>
    </ArtifactContext.Provider>
  );
}

/**
 * What a run used (roadmap 28c): input read fresh, written to and read from the prompt cache, output, and the share read
 * from the cache. A run from before 28c has its input as one number and no cache counts.
 */
function TokensLine({ tokens: k }: { tokens: RunTokens }) {
  const t = useT();
  const n = (v: number | null) => (v === null ? "?" : formatCount(v));
  const share = cacheReadShare(k);
  return (
    <NoteLine>
      {k.cacheReadTokens === null
        ? t("runs.tokensOld", { input: n(k.inputTokens), output: n(k.outputTokens) })
        : t("runs.tokens", { input: n(k.inputTokens), write: n(k.cacheWriteTokens), read: n(k.cacheReadTokens), output: n(k.outputTokens), share: share === null ? "—" : `${Math.round(share * 100)}%` })}
    </NoteLine>
  );
}

/** What RTK says it left out of the run's Bash output (roadmap 28d): its own estimate, said so. */
function CompressionLine({ compression: c }: { compression: RunCompression }) {
  const t = useT();
  const saved = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(c.saved);
  return <NoteLine>{t("runs.compression", { commands: formatCount(c.commands), saved })}</NoteLine>;
}

const PIPELINE_KIND: Partial<Record<string, ChipKind>> = { success: "success", failed: "danger", running: "running", pending: "running", canceled: "neutral", skipped: "neutral", manual: "info" };

/**
 * The run's MR or PR as its machine last saw it, and Merge for someone with Code review (roadmap 18c): the machine merges
 * with its own GitLab or GitHub token at its next heartbeat. The hub refuses a draft, a failed pipeline, your own run.
 */
function MrMerge({ run, onChanged }: { run: RunRecord; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const mr = run.mr;
  const merge = run.merge;
  const label = mrLabel({ mrUrl: run.mrUrl, iid: mr?.iid ?? null });
  const open = !mr?.status || mr.status === "opened";
  const waiting = merge?.status === "pending";
  const can = allow(run.project, "codeReview") && open && !mr?.draft && mr?.pipeline !== "failed" && !waiting && merge?.status !== "merged";
  const pipelineDone = !mr?.pipeline || ["success", "skipped", "manual", "canceled"].includes(mr.pipeline);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <a className="font-medium text-fg-link underline underline-offset-2" href={run.mrUrl!} target="_blank" rel="noreferrer" title={run.mrUrl!}>
          {mr ? label : run.mrUrl}
        </a>
        {mr?.status ? <Chip kind={mr.status === "merged" ? "success" : mr.status === "closed" ? "neutral" : "info"} small>{t(`mrStatus.${mr.status}`)}</Chip> : null}
        {mr?.draft ? <Chip kind="warning" small title={t("runs.mrDraftNote")}>draft</Chip> : null}
        {mr?.pipeline ? (
          <Chip kind={PIPELINE_KIND[mr.pipeline] ?? "info"} small>
            {mr.pipelineUrl ? (
              <a className="underline-offset-2 hover:underline" href={mr.pipelineUrl} target="_blank" rel="noreferrer">
                {t("runs.mrChecks", { status: t(`pipelineStatus.${mr.pipeline}`) })}
              </a>
            ) : (
              t("runs.mrChecks", { status: t(`pipelineStatus.${mr.pipeline}`) })
            )}
          </Chip>
        ) : null}
        {mr?.checkedAt ? <span className="text-fg-muted">{t("runs.mrSeen", { time: formatTime(mr.checkedAt) })}</span> : null}
        {can ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={action.busy}
            title={t("runs.mergeHint", { machine: run.machine })}
            onClick={() => {
              if (!pipelineDone && !window.confirm(t("runs.mergeConfirm", { mr: label, status: t(`pipelineStatus.${mr!.pipeline!}`) }))) return;
              void action.run(async () => {
                await client.call("runs.merge", { machineId: run.machineId, runId: run.runId });
                onChanged();
              });
            }}
          >
            {t("runs.merge")}
          </Button>
        ) : null}
      </div>
      {waiting ? <Notice tone="info">{t("runs.mergeWaiting", { who: merge.requestedBy, time: formatTime(merge.requestedAt), machine: run.machine })}</Notice> : null}
      {merge?.status === "merged" ? <NoteLine tone="info">{t("runs.merged", { who: merge.requestedBy, time: formatTime(merge.finishedAt ?? merge.requestedAt) })}</NoteLine> : null}
      {merge?.status === "failed" ? (
        <Notice tone="warn" className="[overflow-wrap:anywhere]">
          {t("runs.mergeFailed", { who: merge.requestedBy, time: formatTime(merge.finishedAt ?? merge.requestedAt), reason: merge.error ? requestErrorText(merge.error) : "" })}
        </Notice>
      ) : null}
      <ErrorNote error={action.error} />
    </div>
  );
}

/**
 * A review that asks for changes: one click queues the fix on the same machine, like runs.dispatch from the Tasks page.
 * The task's branch keeps its work, and the review's report goes in as the instructions.
 */
function FixRun({ run }: { run: RunRecord }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [reviewAfter, setReviewAfter] = useState(true);
  const [sent, setSent] = useState<RunRequest | null>(null);
  const instructions = fixInstructions(run);
  if (sent) {
    return (
      <Notice tone="ok">
        {t("runs.fixSent", { id: sent.id, machine: sent.machine })}{" "}
        <a className="font-medium underline underline-offset-2" href={`#/tasks?task=${encodeURIComponent(run.taskId)}`}>
          {t("runs.fixOpenTask", { task: run.taskId })}
        </a>
      </Notice>
    );
  }
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line-default bg-surface p-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-[13px]/5 font-semibold text-fg-strong">{t("runs.fixTitle")}</h3>
        <p className="m-0 text-xs text-fg-muted">{t("runs.fixHint", { task: run.taskId, machine: run.machine })}</p>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted select-none">{t("runs.fixInstructions")}</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line-subtle bg-code p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{instructions}</pre>
      </details>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
        {t("board.reviewAfter")}
      </label>
      <div>
        <Button
          size="sm"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              setSent(
                await client.call("runs.dispatch", {
                  machineId: run.machineId,
                  project: run.project,
                  taskId: run.taskId,
                  role: "implement",
                  profileId: null,
                  reviewAfter,
                  candidates: 1,
                  instructions,
                }),
              );
            })
          }
        >
          <Wrench />
          {t("runs.fixSend")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </section>
  );
}
