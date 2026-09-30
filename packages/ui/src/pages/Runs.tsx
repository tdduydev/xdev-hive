// Lượt chạy (docs/design/2026-09-redesign, xDev Hive Client): this machine's runs (desktop) and the ones the team's
// machines pushed to the hub (runs.push), in one list: running here, on other machines, recent. The detail shows the
// run's log by level and, for a run on this machine, its changes.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import { cn } from "cn";
import { parseVerdict, type AgentRun, type RunRecord, type RunRequest } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { errorMessage, formatCount, formatTime, formatUsd, useAction, useCan, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { fixInstructions, isLive, latestReviews, runDuration, runLabel } from "#ui/lib/runs.ts";
import { parseLog, parsePatch, runSteps, type DiffFile, type LogLevel } from "#ui/lib/runlog.ts";
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
const MARK: Record<string, [string, string]> = {
  running: ["●", "text-running"],
  queued: ["◌", "text-fg-muted"],
  succeeded: ["✓", "text-success"],
  failed: ["✗", "text-danger"],
  rate_limited: ["!", "text-warning"],
  cancelled: ["–", "text-fg-muted"],
};

export function RunsPage() {
  const { client, me, scope } = useHive();
  const t = useT();
  const desktop = client.desktop;
  const hubMode = me.mode === "hub";
  const [active, setActive] = useState(false);
  const tick = useRefresh(active);
  const key = scopeKey(scope);
  const local = useQuery(async () => (desktop ? desktop.runs({ ...scopeFilter(scope), limit: 100 }) : []), [desktop, key, tick]);
  const hub = useQuery(async () => (hubMode ? client.call("runs.list", { ...scopeFilter(scope), limit: 100 }) : []), [client, hubMode, key, tick]);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  const machine = settings.data?.machine ?? null;

  const rows = useMemo(() => {
    const mine = new Set((local.data ?? []).map((r) => r.id));
    const localRows: Row[] = (local.data ?? []).map((run) => ({ src: "local", key: `local/${run.id}`, run }));
    const hubRows: Row[] = (hub.data ?? []).filter((r) => !mine.has(r.runId)).map((run) => ({ src: "hub", key: `${run.machineId}/${run.runId}`, run }));
    const newest = (a: Row, b: Row) => rowTime(b).localeCompare(rowTime(a));
    return {
      here: localRows.filter((r) => isLive(r.run)).sort(newest),
      other: hubRows.filter((r) => isLive(r.run)).sort(newest),
      recent: [...localRows, ...hubRows].filter((r) => !isLive(r.run)).sort(newest).slice(0, 60),
    };
  }, [local.data, hub.data]);
  const all = useMemo(() => [...rows.here, ...rows.other, ...rows.recent], [rows]);
  useEffect(() => setActive(all.some((r) => isLive(r.run))), [all]);

  const [selected, setSelected] = useState<string | null>(null);
  const [linked, clearLinked] = useHashParam("run");
  useEffect(() => {
    if (!linked) return;
    const found = all.find((r) => rowId(r) === linked);
    if (found) {
      setSelected(found.key);
      clearLinked();
    }
  }, [linked, all, clearLinked]);
  const current = all.find((r) => r.key === selected) ?? all[0] ?? null;
  const latest = latestReviews((hub.data ?? []) as RunRecord[]);
  const loaded = !local.loading && !hub.loading;

  let index = 0;
  const group = (label: string | null, list: Row[]) =>
    list.length ? (
      <>
        {label ? <div className="px-2 pt-2.5 pb-1 text-[11px]/4 font-semibold text-fg-muted">{label}</div> : null}
        {list.map((r) => (
          <RunRow key={r.key} row={r} index={index++} on={r.key === current?.key} machine={machine} onPick={() => setSelected(r.key)} />
        ))}
      </>
    ) : null;

  return (
    <div className="flex h-full min-h-0 w-full bg-surface">
      <div className="flex min-w-[240px] shrink basis-[300px] flex-col overflow-y-auto border-r border-line-subtle p-1.5">
        <ErrorNote error={local.error ?? hub.error} />
        {desktop ? (
          <>
            <div className="px-2 pt-2.5 pb-1 text-[11px]/4 font-semibold text-fg-muted">{t("runs.here", { count: rows.here.length })}</div>
            {rows.here.map((r) => (
              <RunRow key={r.key} row={r} index={index++} on={r.key === current?.key} machine={machine} onPick={() => setSelected(r.key)} />
            ))}
          </>
        ) : null}
        {group(hubMode ? t("runs.otherMachines") : null, rows.other)}
        {group(t("runs.recent"), rows.recent)}
        {loaded && all.length === 0 ? <div className="px-3 py-8 text-center text-[13px] text-fg-muted">{hubMode && !desktop ? t("runs.none") : t("runs.noneHere")}</div> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {current ? (
          current.src === "local" ? (
            <LocalDetail key={current.key} run={current.run} machine={machine ?? "—"} gitlabReady={Boolean((settings.data?.gitlab.url && settings.data.gitlab.hasToken) || settings.data?.github?.hasToken)} group={local.data ?? []} onChanged={local.reload} />
          ) : (
            <HubDetail key={current.key} run={current.run} latestReview={latest.has(current.key)} onChanged={hub.reload} />
          )
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">{loaded ? t("runs.pick") : null}</div>
        )}
      </div>
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

function RunRow({ row, index, on, machine, onPick }: { row: Row; index: number; on: boolean; machine: string | null; onPick: () => void }) {
  const t = useT();
  const r = row.run;
  const [mark, markCls] = MARK[r.status] ?? ["•", "text-fg-muted"];
  const live = isLive(r);
  const where = row.src === "hub" ? row.run.machine : machine;
  return (
    <div
      role="button"
      tabIndex={0}
      data-run-index={index}
      data-run-status={r.status}
      data-best={row.src === "local" && row.run.bestOf ? (row.run.bestOf.n === 0 ? "judge" : row.run.bestOf.pick === row.run.bestOf.n ? "kept" : "candidate") : undefined}
      onClick={onPick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick())}
      className={cn("flex cursor-pointer flex-col gap-1 rounded-sm px-2.5 py-[9px] outline-none focus-visible:focus-ring", on ? "bg-selected" : "hover:bg-hover")}
    >
      <div className="flex gap-1.5 font-mono text-[11px]/none font-medium text-fg-muted">
        <span className={markCls}>{mark}</span>
        <span className="min-w-0 truncate">
          {rowId(row)} · {r.taskId}
        </span>
        <span className="ml-auto shrink-0">{live ? runDuration(r) : formatTime(rowTime(row))}</span>
      </div>
      <span className="truncate text-[13px]/[18px] font-semibold text-fg-strong">{r.taskTitle}</span>
      <span className="truncate text-xs/4 text-fg-muted">
        {[r.profileId, runLabel("agentRole", r.role), row.src === "hub" && where ? where : null, row.src === "local" ? bestOfText(row.run, t) : null]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {r.status === "running" ? (
        <span className="relative h-[3px] overflow-hidden rounded-full bg-sunken" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 w-2/5 animate-[xd-indeterminate_1.6s_var(--ease-standard)_infinite] rounded-full bg-brand-gradient-h motion-reduce:animate-none" />
        </span>
      ) : null}
    </div>
  );
}

function stateLabel(run: { status: string; startedAt: string | null; finishedAt: string | null }, t: TFunction): string {
  const time = runDuration(run);
  const state = runLabel("runStatus", run.status);
  return time ? t("runs.stateTime", { state, time }) : state;
}

/** Header of a run's detail: state, ids, title, profile · role · branch, the actions, then any notes. */
function Head({ run, machine, actions, notes }: { run: AgentRun | RunRecord; machine: string; actions: ReactNode; notes?: ReactNode }) {
  const t = useT();
  const id = "id" in run ? run.id : run.runId;
  const kind = STATE[run.status] ?? "neutral";
  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-b border-line-subtle px-5 pt-3.5 pb-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex h-5 items-center rounded-xs px-[7px] text-[11px]/none font-semibold whitespace-nowrap", CHIP[kind])}>{stateLabel(run, t)}</span>
            <span className="font-mono text-xs/none font-medium text-fg-muted">
              {id} · {run.project} · {run.taskId} · {machine}
            </span>
          </div>
          <h2 className="m-0 font-display text-[17px]/6 font-semibold text-fg-strong">{run.taskTitle}</h2>
          <span className="font-mono text-xs/4 text-fg-muted">
            {[run.profileId ?? t("board.waitingProfile"), runLabel("agentRole", run.role), run.branch ? t("runs.worktree", { branch: run.branch }) : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">{actions}</div>
      </div>
      {notes}
    </div>
  );
}

const LEVEL_CLS: Record<LogLevel, string> = {
  tool: "text-fg-brand",
  ok: "text-success",
  error: "text-danger",
  agent: "text-fg-muted",
  meta: "text-fg-muted",
  section: "text-fg-strong",
};

/** The log by level (TOOL / OK / LỖI / AGENT); the prompt folds away, the view follows a live run. */
function LogView({ text, live, wrap, empty }: { text: string; live: boolean; wrap: boolean; empty: string }) {
  const t = useT();
  const lines = useMemo(() => parseLog(text), [text]);
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
              <span title={l.at ?? undefined} className="w-[58px] shrink-0 text-fg-disabled tabular-nums">
                {l.at && (i === 0 || lines[i - 1]!.at !== l.at) ? clock(l.at) : ""}
              </span>
            ) : null}
            <span className={cn("w-[46px] shrink-0 font-semibold", LEVEL_CLS[l.level])}>{l.level === "agent" && !l.text ? "" : t(`runs.level.${l.level}`)}</span>
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
    <ol aria-label={t("runs.steps")} className="m-0 flex shrink-0 list-none items-center gap-1.5 overflow-x-auto border-b border-line-subtle px-4 py-2.5">
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

function DiffView({ files, error }: { files: DiffFile[] | null; error: string | null }) {
  const t = useT();
  if (error) return <div className="p-3.5 text-[13px] text-danger">{error}</div>;
  if (!files) return null;
  if (!files.length) return <div className="p-3.5 text-[13px] text-fg-muted">{t("runs.noDiff")}</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3.5 py-3">
      {files.map((f) => (
        <div key={f.path} className="flex gap-2.5 font-mono text-xs/5 text-code-fg">
          <span className="min-w-0 flex-1 truncate">{f.path}</span>
          {f.binary ? <span className="text-fg-muted">{t("runs.binary")}</span> : null}
          <span className="text-success">+{f.adds}</span>
          <span className="text-danger">−{f.dels}</span>
        </div>
      ))}
      {files
        .filter((f) => f.lines.length)
        .map((f) => (
          <div key={`d-${f.path}`} className="overflow-hidden rounded-md border border-line-subtle bg-surface font-mono text-xs/5">
            <div className="flex h-7 items-center border-b border-line-subtle bg-subtle px-3 text-[11px]/none font-medium text-fg-muted">{f.path}</div>
            {f.lines.map((l, i) => (
              <div key={i} className={cn("flex text-code-fg", l.kind === "add" ? "bg-diff-add" : l.kind === "del" ? "bg-diff-del" : l.kind === "hunk" ? "bg-diff-hunk text-diff-hunk-fg" : "")}>
                <span className={cn("w-[26px] shrink-0 text-center text-fg-muted", l.kind === "add" ? "bg-diff-add-gutter" : l.kind === "del" ? "bg-diff-del-gutter" : "")}>
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                </span>
                <span className="min-w-0 px-2.5 whitespace-pre">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** The dark log area with its tabs (Log, Changes), wrap and copy. */
function LogArea({ log, live, diff, diffError, onDiffTab }: { log: string; live: boolean; diff?: DiffFile[] | null; diffError?: string | null; onDiffTab?: () => void }) {
  const t = useT();
  const toast = useToast();
  const [tab, setTab] = useState<"log" | "diff">("log");
  const [wrap, setWrap] = useState(true);
  const tabs: Array<["log" | "diff", string]> = [["log", t("runs.tabLog")]];
  if (onDiffTab) tabs.push(["diff", t("runs.tabDiff", { count: diff?.length ?? "…" })]);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-code">
      <div className="flex h-[34px] shrink-0 items-center gap-0.5 border-b border-line-subtle bg-subtle pr-2 pl-3">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              if (k === "diff") onDiffTab?.();
            }}
            className={cn("h-[34px] cursor-pointer border-b-2 px-2.5 text-xs/none font-semibold outline-none focus-visible:focus-ring", tab === k ? "border-primary text-fg-strong" : "border-transparent text-fg-muted")}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className={cn("h-6 cursor-pointer rounded-[5px] px-2 text-[11px]/none font-medium text-fg-secondary outline-none focus-visible:focus-ring", wrap ? "bg-selected" : "hover:bg-hover")}
        >
          {t("runs.wrap")}
        </button>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(log).then(() => toast(t("runs.copied")), () => undefined)}
          className="h-6 cursor-pointer rounded-[5px] px-2 text-[11px]/none font-medium text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
        >
          {t("runs.copyLog")}
        </button>
      </div>
      {tab === "log" ? <LogView text={log} live={live} wrap={wrap} empty={live ? t("board.waitingOutput") : t("board.noLog")} /> : <DiffView files={diff ?? null} error={diffError ?? null} />}
    </div>
  );
}

function NoteLine({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "info" | "danger" }) {
  return <div className={cn("text-xs/[18px] [overflow-wrap:anywhere]", tone === "info" ? "text-info" : tone === "danger" ? "text-danger" : "text-fg-muted")}>{children}</div>;
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
  const mr = run.mrUrl ? (/\/pull\/\d+$/.test(run.mrUrl) ? `PR #${run.mrIid}` : `MR !${run.mrIid}`) : null;

  const actions = (
    <>
      {run.worktree ? (
        <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(() => desktop.showInFolder(run.worktree!))}>
          {t("board.openWorktree")}
        </Button>
      ) : null}
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
      {!live && !b ? (
        <Button
          size="sm"
          variant="outline"
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
          {run.costUsd !== null
            ? ` · ${t("board.costDetail", { cost: formatUsd(run.costUsd), input: run.inputTokens === null ? "?" : formatCount(run.inputTokens), output: run.outputTokens === null ? "?" : formatCount(run.outputTokens) })}`
            : ""}
        </NoteLine>
      ) : null}
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
            {t("board.ciFixOf", { mr: /\/pull\/\d+$/.test(run.ciFix.mrUrl) ? `PR #${run.ciFix.mrIid ?? "?"}` : `MR !${run.ciFix.mrIid ?? "?"}`, n: run.ciFix.n, max: run.ciFix.max })}
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
      <ErrorNote error={action.error} />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Head run={run} machine={machine} actions={actions} notes={notes} />
      <Steps run={run} log={log.data ?? ""} />
      <LogArea log={log.data ?? ""} live={live} diff={diff} diffError={diffError} onDiffTab={loadDiff} />
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
  const verdict = run.role === "review" && run.status === "succeeded" ? parseVerdict(run.summary) : "none";
  const tick = useRefresh(live);
  const full = useQuery(() => client.call("runs.get", { machineId: run.machineId, runId: run.runId }), [client, run.machineId, run.runId, tick]);
  const manage = allow(run.project, "manage");
  const patchFiles = useMemo(() => (full.data?.patch ? parsePatch(full.data.patch) : []), [full.data?.patch]);

  const actions = live ? (
    run.cancelRequestedBy ? null : manage ? (
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
    ) : (
      <span className="text-xs/7 text-fg-muted">{t("runs.onlyView", { machine: run.machine })}</span>
    )
  ) : null;

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
      {run.mrUrl ? (
        <NoteLine>
          <a className="font-medium text-fg-link underline underline-offset-2 [overflow-wrap:anywhere]" href={run.mrUrl} target="_blank" rel="noreferrer">
            {run.mrUrl}
          </a>
        </NoteLine>
      ) : null}
      {live && run.cancelRequestedBy ? <Notice tone="warn">{t("runs.cancelRequested", { who: run.cancelRequestedBy, time: formatTime(run.cancelRequestedAt) })}</Notice> : null}
      {run.error ? <Notice tone={run.status === "queued" ? "info" : "warn"} className="[overflow-wrap:anywhere]">{run.error}</Notice> : null}
      {run.summary && !live ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">{t("runs.summary")}</span>
          <p className="m-0 max-h-40 overflow-y-auto text-[13px]/5 whitespace-pre-wrap text-fg-primary [overflow-wrap:anywhere]">{run.summary}</p>
        </div>
      ) : null}
      {verdict === "changes" && latestReview && manage ? <FixRun run={run} /> : null}
      <ErrorNote error={action.error ?? full.error} />
      <NoteLine>{t("runs.logNote", { time: formatTime(run.updatedAt) })}</NoteLine>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Head run={run} machine={run.machine} actions={actions} notes={notes} />
      <Steps run={run} log={full.data?.log ?? ""} />
      {/* What it changed, as its machine sent it; a hub older than 22l has no patches (no tab). */}
      <LogArea
        log={full.data?.log ?? ""}
        live={live}
        {...(full.data && full.data.patch !== undefined
          ? { diff: full.data.patch ? patchFiles : full.data.patch === "" ? [] : null, diffError: full.data.patch === null ? t("runs.patchNotSent", { machine: run.machine }) : null, onDiffTab: () => undefined }
          : {})}
      />
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
