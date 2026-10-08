import { useMemo } from "react";
import { ArrowRight, CircleCheck, Clock3, ListChecks, MessageSquare, TriangleAlert } from "lucide-react";
import { Button } from "#ui/components/ui/button.tsx";
import { Badge, ErrorNote, Page, PageHeader } from "#ui/components/common.tsx";
import { useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { useInbox } from "#ui/shell/inbox.tsx";
import type { InboxItem } from "#ui/lib/inbox.ts";
import { TodayInboxPage } from "#ui/pages/Today.tsx";

const href = (page: string) => `#/${page}`;
function subject(item: InboxItem): string {
  switch (item.kind) {
    case "review": case "agentHold": case "releaseFailure": return `${item.task.id} · ${item.task.title}`;
    case "plan": return `${item.plan.taskId} · ${item.plan.taskTitle}`;
    case "gate": return item.gate.taskId;
    case "leader": return item.action.reason;
    case "proposal": case "cleanup": return item.proposal.reason;
    case "memory": case "conflict": return item.memory.content;
    case "ci": return `${item.run.taskId} · ${item.run.taskTitle}`;
    case "waitingRun": return `${item.run.taskId} · ${item.run.taskTitle}`;
    case "machine": return item.item.label;
    case "request": return item.command.label;
    case "alert": return item.alert.rule;
  }
}

/** The overview reads the same permission-filtered sources as the existing work pages. */
export function WorkspaceHome() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const can = useCan();
  const inbox = useInbox();
  const tick = usePoll(20_000);
  const tasks = useQuery(() => scope.kind === "shared" ? Promise.resolve([]) : client.call("tasks.list", scopeFilter(scope)), [client, scopeKey(scope), tick]);
  const runs = useQuery(() => scope.kind === "shared" ? Promise.resolve([]) : client.call("runs.list", { ...scopeFilter(scope), limit: 200 }), [client, scopeKey(scope), tick]);
  const active = (runs.data ?? []).filter(r => r.status === "running" || r.status === "queued");
  const blocked = (tasks.data ?? []).filter(task => task.status === "blocked");
  const completed = (tasks.data ?? []).filter(task => task.status === "done");
  const decisions = useMemo(() => inbox.items.filter(i => ["plan", "review", "gate", "leader", "proposal", "memory", "conflict"].includes(i.kind)), [inbox.items]);
  const metrics = [
    { label: t("workspace.decisions"), count: inbox.loading ? "—" : decisions.length, icon: ListChecks, page: "today?section=inbox" },
    { label: t("workspace.running"), count: runs.data ? active.length : "—", icon: Clock3, page: "runs" },
    { label: t("workspace.blocked"), count: tasks.data ? blocked.length : "—", icon: TriangleAlert, page: "tasks?status=blocked" },
    { label: t("workspace.completed"), count: tasks.data ? completed.length : "—", icon: CircleCheck, page: "tasks?status=done" },
  ];
  return <Page wide className="workspace-home">
    <PageHeader title={t("workspace.title")} subtitle={t("workspace.subtitle")} actions={(can(null, "chatUse") || projects.some(project => can(project, "chatUse"))) ? <Button asChild><a href={href("chat")}><MessageSquare aria-hidden="true" />{t("workspace.newWork")}</a></Button> : undefined} />
    <ErrorNote error={tasks.error ?? runs.error ?? inbox.error} />
    <div className="workspace-metrics">{metrics.map(({ label, count, icon: Icon, page }) => <a key={page} href={href(page)} className="workspace-metric"><span className="workspace-metric-label"><Icon aria-hidden="true" className="size-4" />{label}</span><strong>{count}</strong><span className="workspace-metric-link">{t("workspace.open")}<ArrowRight aria-hidden="true" className="size-4" /></span></a>)}</div>
    {(tasks.data?.length ?? 0) >= 500 || (runs.data?.length ?? 0) >= 200 ? <p className="text-sm text-fg-muted">{t("workspace.capped")}</p> : null}
    <div className="workspace-columns">
      <section className="workspace-panel"><header><h2>{t("workspace.decisions")}</h2><Badge tone="warn">{decisions.length}</Badge></header>
        {inbox.loading && !decisions.length ? <p className="workspace-empty">{t("common.loading")}</p> : null}
        {!inbox.loading && !decisions.length ? <div className="workspace-empty"><CircleCheck aria-hidden="true" className="size-7 text-success" /><h3>{t("inbox.allDone")}</h3><p>{t("inbox.allDoneBody")}</p></div> : null}
        {decisions.slice(0, 6).map(item => <article key={item.key} className="workspace-item"><div className="workspace-item-heading"><Badge tone={item.tone}>{t(`inbox.tag.${item.kind}`)}</Badge><span className="text-xs text-fg-muted">{item.scope || t("inbox.shared")}</span></div><h3>{subject(item)}</h3><Button asChild variant="outline"><a href={href(`today?item=${encodeURIComponent(item.key)}&section=inbox`)}>{t("workspace.inspect")}<ArrowRight aria-hidden="true" /></a></Button></article>)}
        <a className="workspace-text-link" href={href("today?section=inbox")}>{t("workspace.allInbox")}<ArrowRight aria-hidden="true" className="size-4" /></a>
      </section>
      <div className="workspace-side"><section className="workspace-panel"><header><h2>{t("workspace.running")}</h2><Badge>{active.length}</Badge></header>{!active.length ? <p className="workspace-empty">{runs.loading ? t("common.loading") : t("workspace.noRuns")}</p> : null}{active.slice(0, 4).map(run => <article className="workspace-item" key={`${run.machineId}/${run.runId}`}><Badge tone="running">{t(run.status === "running" ? "runStatus.running" : "runStatus.queued")}</Badge><h3>{run.taskTitle || run.taskId}</h3><p className="text-sm text-fg-muted">{run.machine} · {run.profileId || "—"}</p><a className="workspace-text-link" href={href(`runs?run=${encodeURIComponent(`${run.machineId}/${run.runId}`)}`)}>{t("workspace.openRun")}<ArrowRight aria-hidden="true" className="size-4" /></a></article>)}</section>
      <section className="workspace-panel"><header><h2>{t("workspace.blocked")}</h2><Badge tone="danger">{blocked.length}</Badge></header>{blocked.slice(0, 3).map(task => <article key={task.id} className="workspace-item"><h3>{task.title}</h3><p className="text-sm text-fg-muted line-clamp-2">{task.note || t("workspace.inspectBlocker")}</p><a className="workspace-text-link" href={href(`tasks?task=${encodeURIComponent(task.id)}`)}>{t("workspace.inspectBlocker")}<ArrowRight aria-hidden="true" className="size-4" /></a></article>)}{!blocked.length ? <p className="workspace-empty">{t("workspace.noBlockers")}</p> : null}</section>
      <section className="workspace-panel"><header><h2>{t("workspace.next")}</h2></header><div className="workspace-shortcuts"><a href={href("features")}>{t("nav.features")}<ArrowRight aria-hidden="true" className="size-4" /></a><a href={href("docs")}>{t("nav.docs")}<ArrowRight aria-hidden="true" className="size-4" /></a><a href={href("pipeline")}>{t("workspace.acceptance")}<ArrowRight aria-hidden="true" className="size-4" /></a></div></section></div>
    </div>
  </Page>;
}

export function WebTodayPage({ inboxView }: { inboxView: boolean }) {
  const t = useT();
  return inboxView ? <div className="workspace-inbox"><a className="workspace-back" href="#/today">← {t("workspace.back")}</a><TodayInboxPage /></div> : <WorkspaceHome />;
}
