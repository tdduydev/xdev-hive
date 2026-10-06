import { ResponsiveTable as Table, ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { useEffect, useState, type ReactNode } from "react";
import type { Machine, MapPhase, RunGroup, RunGroupItem, RunGroupRun, RunRequest } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, OwnerBadge, Page, PageHeader } from "#ui/components/common.tsx";
import { formatTime, formatUsd, useAction, useCan, useHashParam, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { requestErrorText, runLabel } from "#ui/lib/runs.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";

/** A group with something going is looked at again this often, so its next items show as the hub sends them. */
const OPEN_MS = 5000;

/** Đợt chạy (roadmap 31a): run groups, newest first, each with what became of its tasks. */
export function BatchesPage() {
  const { client, scope } = useHive();
  const t = useT();
  const [open, setOpen] = useState(false);
  const poll = usePoll(open ? OPEN_MS : null);
  const groups = useQuery(() => client.call("runs.groups", { ...scopeFilter(scope), limit: 30 }), [client, scopeKey(scope), poll]);
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  useEffect(() => setOpen((groups.data ?? []).some((g) => !g.closedAt)), [groups.data]);
  // A link from the Tasks page (#/batches?group=…) brings that group into view.
  const [linked, clearLinked] = useHashParam("group");
  useEffect(() => {
    if (!linked || !groups.data) return;
    document.getElementById(`group-${linked}`)?.scrollIntoView({ block: "start" });
    clearLinked();
  }, [linked, groups.data, clearLinked]);
  return (
    <Page>
      <PageHeader title={t("nav.batches")} subtitle={t("navSub.batches")} />
      <ErrorNote error={groups.error} />
      {groups.data?.length === 0 ? <Empty>{t("batches.none")}</Empty> : null}
      {(groups.data ?? []).map((g) => (
        <GroupCard key={g.id} group={g} machines={machines.data ?? []} onChanged={groups.reload} />
      ))}
    </Page>
  );
}

function GroupCard({ group: g, machines, onChanged }: { group: RunGroup; machines: Machine[]; onChanged: () => void }) {
  const t = useT();
  const { client } = useHive();
  const allow = useCan();
  const action = useAction();
  const active = g.items.filter((i) => i.active).length;
  const held = g.items.filter((i) => i.status === "held").length;
  const failed = g.items.filter((i) => failedItem(i)).length;
  const done = g.items.filter((i) => !i.active && i.status === "sent" && !failedItem(i)).length;
  // One prompt, several agents (roadmap 31e): once all are done, one is kept and the others closed.
  const fanout = g.kind === "fanout";
  const canPick = fanout && !g.winnerTask && held === 0 && active === 0 && allow(g.project, "taskManage") && allow(g.project, "runDispatch");
  const pick = (taskId: string) => void action.run(async () => (await client.call("runs.pickWinner", { groupId: g.id, taskId }), onChanged()));
  // A job in parts (roadmap 31c): its split and merge run outside the items, and a stopped one starts again from here.
  const job = g.kind === "mapreduce";
  const parting = job && g.phase !== "map" && !g.items.length;
  // A chain of roles on one task (roadmap 31d): one step at a time; a failed or cancelled one starts again from here.
  const chain = g.kind === "roles";
  const step = g.items.findIndex((i) => i.status === "held" || i.active);
  const stoppable = job || chain;
  const resume = () => void action.run(async () => (await client.call("runs.resumeGroup", { id: g.id }), onChanged()));
  return (
    <Card id={`group-${g.id}`} className="gap-3 py-4" data-group={g.id}>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <b className="font-semibold wrap-anywhere">{g.title || t("batches.untitled", { id: g.id })}</b>
              <Badge tone="accent">{t(`batches.kind.${g.kind}`)}</Badge>
              <OwnerBadge owner={g.project} />
            </div>
            <span className="text-xs text-muted-foreground">
              {t("batches.by", { who: g.createdBy, time: formatTime(g.createdAt) })}
              {g.parentTask ? (
                <>
                  {" · "}
                  <a className="underline underline-offset-2" href={`#/tasks?task=${encodeURIComponent(g.parentTask)}`}>
                    {t(job ? "batches.job" : chain ? "batches.task" : "batches.parent", { task: g.parentTask })}
                  </a>
                </>
              ) : null}
              {stoppable && g.machineId ? ` · ${t("batches.machine", { machine: machines.find((m) => m.id === g.machineId)?.machine ?? g.machineId })}` : null}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-xs">
            {job && g.phase ? (
              <span data-map-phase={g.phase}>
                <Badge tone={PHASE_TONE[g.phase]}>{t(`batches.phase.${g.phase}`)}</Badge>
              </span>
            ) : null}
            {chain ? (
              <span data-roles-phase={g.phase ?? "going"}>
                <Badge tone={g.phase === "done" ? "ok" : g.phase === "stopped" ? "danger" : "running"}>
                  {g.phase === "done" || g.phase === "stopped" ? t(`batches.rolesPhase.${g.phase}`) : t("batches.rolesPhase.going", { n: Math.max(step, 0) + 1, total: g.items.length })}
                </Badge>
              </span>
            ) : null}
            {/* A stopped job is closed too, but not over: Chạy lại goes on from where it stopped. */}
            {g.closedAt && g.phase === "stopped" ? null : g.closedAt ? (
              <span className="text-muted-foreground">{t("batches.over", { time: formatTime(g.closedAt) })}</span>
            ) : parting ? null : (
              <span className="font-medium text-info">{g.maxParallel ? t("batches.parallel", { active, max: g.maxParallel }) : t("batches.parallelAll", { active })}</span>
            )}
            {parting ? null : <span className="text-muted-foreground">{t("batches.counts", { held, done, failed })}</span>}
          </div>
          {!g.closedAt && allow(g.project, "runDispatch") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              onClick={() => {
                if (window.confirm(t("batches.confirmCancel", { id: g.id }))) void action.run(async () => (await client.call("runs.cancelGroup", { id: g.id }), onChanged()));
              }}
            >
              {t("batches.cancel")}
            </Button>
          ) : null}
          {stoppable && g.phase === "stopped" && allow(g.project, "runDispatch") ? (
            <Button size="sm" disabled={action.busy} onClick={resume} data-map-resume>
              {t("batches.resume")}
            </Button>
          ) : null}
        </div>
        {stoppable && g.phase === "stopped" && g.phaseError ? <p className="text-xs text-danger">{t("batches.stopped", { error: requestErrorText(g.phaseError) })}</p> : null}
        {job && g.phaseRequest ? (
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs" data-map-run={g.items.length ? "reduce" : "split"}>
            <span className="font-medium">{t(g.items.length ? "batches.mergeRun" : "batches.splitRun")}</span>
            <RequestState request={g.phaseRequest} run={g.phaseRun} machine={g.phaseRequest.machine} t={t} />
          </div>
        ) : null}
        {job && g.phase === "ready" ? (
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t("batches.parts", { count: g.parts.length })}</span>
            <ol className="list-decimal pl-5 text-[13px]">
              {g.parts.map((p, i) => (
                <li key={i} className="wrap-anywhere">
                  {p}
                </li>
              ))}
            </ol>
            {allow(g.project, "taskManage") && allow(g.project, "runDispatch") ? (
              <a className="w-fit font-medium underline underline-offset-2" href={`#/tasks?split=${g.id}`} data-map-edit={g.id}>
                {t("batches.editParts")}
              </a>
            ) : null}
          </div>
        ) : null}
        <ErrorNote error={action.error} />
        {g.items.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="table-fixed md:min-w-[40rem]">
              <colgroup>
                <col />
                <col className="w-44" />
                <col className="w-56" />
                {fanout ? <col className="w-36" /> : null}
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("batches.colTask")}</TableHead>
                  <TableHead>{t("batches.colWhere")}</TableHead>
                  <TableHead>{t("batches.colState")}</TableHead>
                  {fanout ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.items.map((item) => (
                  <ItemRow key={item.id} item={item} machines={machines}>
                    {fanout ? (
                      <TableCell className="align-top text-xs whitespace-normal">
                        {g.winnerTask ? (
                          g.winnerTask === item.taskId ? (
                            <Badge tone="ok">{t("batches.kept")}</Badge>
                          ) : (
                            <span className="text-muted-foreground">{t("batches.notKept")}</span>
                          )
                        ) : item.run?.status === "succeeded" && allow(g.project, "runDispatch") ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canPick || action.busy}
                            title={canPick ? undefined : t("batches.pickHint")}
                            data-pick-winner={item.taskId}
                            onClick={() => pick(item.taskId)}
                          >
                            {t("batches.pick")}
                          </Button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </ItemRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A job's phase: an agent at work, a person's turn, merged, stopped. */
const PHASE_TONE: Record<MapPhase, string> = {
  split: "running",
  ready: "warn",
  map: "running",
  reduce: "running",
  done: "ok",
  stopped: "danger",
};

/** It will not run: refused, expired, not sent, cancelled, or its run did not succeed. */
function failedItem(i: RunGroupItem): boolean {
  if (i.status === "failed") return true;
  if (i.status !== "sent" || !i.request) return false;
  if (i.request.status === "rejected" || i.request.status === "expired") return true;
  return !!i.run && !i.active && i.run.status !== "succeeded";
}

function ItemRow({ item: i, machines, children }: { item: RunGroupItem; machines: Machine[]; children?: ReactNode }) {
  const t = useT();
  const machine = i.request?.machine ?? machines.find((m) => m.id === i.machineId)?.machine ?? null;
  return (
    <TableRow data-item-task={i.taskId} data-item-step={i.step ?? undefined} data-item-state={itemState(i)}>
      <TableCell className="align-top whitespace-normal">
        <a href={`#/tasks?task=${encodeURIComponent(i.taskId)}`} className="flex min-w-0 items-baseline gap-2 hover:underline">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{i.taskId}</span>
          <span className="min-w-0 wrap-anywhere">{i.taskTitle ?? "—"}</span>
        </a>
        {/* A chain's step says what it does: writing code, tests and docs are all implement runs (roadmap 31d). */}
        <span className="text-xs text-muted-foreground">{i.step ? `${i.position}. ${t(`roleStep.${i.step}`)}` : runLabel("agentRole", i.role)}</span>
      </TableCell>
      <TableCell className="align-top text-xs whitespace-normal">
        <div className="font-mono wrap-anywhere">{machine ?? t("batches.anyMachine")}</div>
        <div className="font-mono text-muted-foreground wrap-anywhere">{i.run?.profileId ?? i.profileId ?? t("board.rotate")}</div>
      </TableCell>
      <TableCell className="align-top text-xs whitespace-normal">
        <ItemState item={i} machine={machine} t={t} />
      </TableCell>
      {children}
    </TableRow>
  );
}

/** One word for tests and styling: where the item is. */
function itemState(i: RunGroupItem): string {
  if (i.status !== "sent") return i.status;
  if (i.run) return i.run.status;
  return i.request?.status ?? "sent";
}

function ItemState({ item: i, machine, t }: { item: RunGroupItem; machine: string | null; t: TFunction }) {
  if (i.status === "held") return <span className="text-muted-foreground">{t("batches.state.held")}</span>;
  if (i.status === "cancelled") return <span className="text-muted-foreground">{t("batches.state.cancelled")}</span>;
  if (i.status === "failed") {
    return (
      <span className="text-danger">
        {t("batches.state.failed")}
        {i.error ? `: ${requestErrorText(i.error)}` : ""}
      </span>
    );
  }
  if (!i.request) return <span>—</span>;
  return <RequestState request={i.request} run={i.run} machine={machine} t={t} />;
}

/** A request and its run: an item's, or a job's split or merge run (roadmap 31c). */
function RequestState({ request: req, run, machine, t }: { request: RunRequest; run: RunGroupRun | null; machine: string | null; t: TFunction }) {
  if (req.status === "pending") return <span className="text-info">{t("batches.state.pending", { machine: machine ?? "?" })}</span>;
  if (req.status === "rejected") {
    return (
      <span className="text-danger">
        {t("batches.state.rejected")}
        {req.error ? `: ${requestErrorText(req.error)}` : ""}
      </span>
    );
  }
  if (req.status === "expired") return <span className="text-warning">{t("batches.state.expired")}</span>;
  if (req.status === "cancelled") return <span className="text-muted-foreground">{t("batches.state.cancelled")}</span>;
  if (!run) return <span className="text-info">{t("batches.state.accepted", { machine: machine ?? "?" })}</span>;
  const tone = run.status === "succeeded" ? "text-success" : run.status === "running" || run.status === "queued" ? "text-info" : "text-danger";
  return (
    <span className="flex flex-col gap-0.5">
      <span className={tone}>
        {runLabel("runStatus", run.status)}
        {run.costUsd ? ` · ${formatUsd(run.costUsd)}` : ""}
      </span>
      <a className="w-fit font-mono underline underline-offset-2" href={`#/runs?run=${encodeURIComponent(run.runId)}`}>
        {run.runId}
      </a>
    </span>
  );
}
