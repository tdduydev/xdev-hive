// The team's agent runs as the machines pushed them to the hub (runs.push): every machine's runs of the projects the
// viewer sees, what a running agent does now, and the end of each run's log. Hub mode only; the Board shows this
// machine's own runs with the full log.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import type { RunRecord } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, formatUsd, useHashParam, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { isLive, runDuration, runLabel } from "../lib/runs.ts";
import { scopeProject } from "../lib/scope.ts";

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

export function RunsPage() {
  const { client, scope } = useHive();
  const t = useT();
  const project = scopeProject(scope);
  const [active, setActive] = useState(false);
  const tick = useRefresh(active);
  const runs = useQuery(() => client.call("runs.list", { project: project ?? undefined, limit: 100 }), [client, project, tick]);
  useEffect(() => setActive((runs.data ?? []).some(isLive)), [runs.data]);
  const [selected, setSelected] = useState<{ machineId: string; runId: string } | null>(null);
  const run = runs.data?.find((r) => r.machineId === selected?.machineId && r.runId === selected?.runId) ?? null;
  // A link from another page (a task's request, a chat reply) opens that run once its machine has reported it.
  const [linked, clearLinked] = useHashParam("run");
  useEffect(() => {
    const found = linked ? runs.data?.find((r) => r.runId === linked) : undefined;
    if (found) setSelected({ machineId: found.machineId, runId: found.runId }), clearLinked();
  }, [linked, runs.data, clearLinked]);

  return (
    <Page wide>
      <PageHeader title={t("nav.runs")} subtitle={t("runs.subtitle")} />
      <ErrorNote error={runs.error} />
      {runs.data?.length === 0 ? <Empty>{t("runs.none")}</Empty> : null}
      <div className={cn("grid grid-cols-1 items-start gap-4", run ? "lg:grid-cols-2" : "")}>
        {runs.data?.length ? (
          <div className="min-w-0 overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("board.colRun")}</TableHead>
                  <TableHead>{t("board.colTask")}</TableHead>
                  <TableHead>{t("board.role")}</TableHead>
                  <TableHead>{t("runs.machine")}</TableHead>
                  <TableHead>{t("tasks.status")}</TableHead>
                  <TableHead>{t("board.colTime")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((r) => {
                  const on = r.machineId === selected?.machineId && r.runId === selected?.runId;
                  return (
                    <TableRow
                      key={`${r.machineId}/${r.runId}`}
                      data-state={on ? "selected" : undefined}
                      className="cursor-pointer data-[state=selected]:bg-brand-soft/60"
                      onClick={() => setSelected({ machineId: r.machineId, runId: r.runId })}
                    >
                      <TableCell className="font-mono text-xs">{r.runId}</TableCell>
                      <TableCell>
                        <div className="font-mono text-xs">
                          {project === null ? `${r.project} · ` : ""}
                          {r.taskId}
                        </div>
                        <div className="max-w-56 truncate text-xs">{r.taskTitle}</div>
                      </TableCell>
                      <TableCell className="text-xs">{runLabel("agentRole", r.role)}</TableCell>
                      <TableCell className="text-xs">
                        <div className="font-mono">{r.machine}</div>
                        <div className="font-mono text-muted-foreground">{r.profileId ?? t("board.auto")}</div>
                      </TableCell>
                      <TableCell>
                        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{runLabel("runStatus", r.status)}</Badge>
                        {r.activity ? (
                          <div className="max-w-64 truncate text-xs text-info" title={r.activity}>
                            {r.activity}
                          </div>
                        ) : r.error ? (
                          <div className="max-w-64 truncate text-xs text-muted-foreground" title={r.error}>
                            {r.error}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTime(r.createdAt)}
                        <div>{runDuration(r)}</div>
                        {r.costUsd !== null ? <div>{t("board.cost", { cost: formatUsd(r.costUsd) })}</div> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {run ? <RunRecordDetail key={`${run.machineId}/${run.runId}`} run={run} onClose={() => setSelected(null)} /> : null}
      </div>
    </Page>
  );
}

function RunRecordDetail({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const { client } = useHive();
  const t = useT();
  const live = isLive(run);
  const tick = useRefresh(live);
  const full = useQuery(() => client.call("runs.get", { machineId: run.machineId, runId: run.runId }), [client, run.machineId, run.runId, tick]);
  const pre = useRef<HTMLPreElement>(null);
  const opened = useRef(false);
  const log = full.data?.log ?? "";
  // The end is where the agent's steps and result are: shown first, then followed while the run goes on.
  useEffect(() => {
    const el = pre.current;
    if (!el || !log) return;
    if (live || !opened.current) el.scrollTop = el.scrollHeight;
    opened.current = true;
  }, [log, live]);

  return (
    <aside className="min-w-0 lg:sticky lg:top-3" aria-label={`Run ${run.runId}`}>
      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <b className="font-mono text-sm">{run.runId}</b>
            <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{runLabel("runStatus", run.status)}</Badge>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground wrap-anywhere">
              {run.project} · {run.taskId} · {runLabel("agentRole", run.role)} · {run.machine} · {run.profileId ?? t("board.waitingProfile")}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
              <X />
            </Button>
          </div>
          <div className="text-sm font-medium wrap-anywhere">{run.taskTitle}</div>
          {run.branch ? (
            <div className="font-mono text-xs break-all text-muted-foreground">
              {run.branch} · {t("board.commits", { count: run.commits })}
            </div>
          ) : null}
          {run.mrUrl ? (
            <a className="text-xs font-medium text-primary underline underline-offset-2 break-all" href={run.mrUrl} target="_blank" rel="noreferrer">
              {run.mrUrl}
            </a>
          ) : null}
          {run.activity ? (
            <div className="flex items-center gap-2 text-xs text-info" aria-live="polite">
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-info" aria-hidden />
              <span className="wrap-anywhere">{t("board.activity", { activity: run.activity })}</span>
            </div>
          ) : null}
          {run.error ? (
            <Notice tone={run.status === "queued" ? "info" : "warn"} className="wrap-anywhere">
              {run.error}
            </Notice>
          ) : null}
          {run.summary && !live ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("runs.summary")}</span>
              <p className="text-sm whitespace-pre-wrap wrap-anywhere">{run.summary}</p>
            </div>
          ) : null}
          <ErrorNote error={full.error} />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t("board.log")}</span>
            <span className="text-xs text-muted-foreground">{t("runs.logNote", { time: formatTime(run.updatedAt) })}</span>
          </div>
          <pre
            className="max-h-[70vh] overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
            ref={pre}
            aria-label="Log"
          >
            {log || (live ? t("board.waitingOutput") : t("board.noLog"))}
          </pre>
        </CardContent>
      </Card>
    </aside>
  );
}
