import { ReviewArtifacts } from "#ui/components/Artifacts.tsx";
import { confirmTaskClose } from "#ui/lib/task-close.ts";
import { useChatPageContext } from "#ui/components/ChatSession.tsx";
import { StartReminder } from "#ui/pages/Start.tsx";
import { knowledgeHref } from "#ui/lib/knowledge.ts";
// Hôm nay (docs/design/2026-09-redesign, xDev Hive Client): a list of what needs the person on the left, the
// selected item with its actions on the right. J / K move, ↵ runs the first button, E marks it seen.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { visibleInterval } from "#ui/lib/visible-interval.ts";
import { CircleCheck, Copy, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { HUB_SCOPE, type ChatAction, type Memory, type SdlcGateRecord } from "@xdev-hive/core";
import { approvalOf } from "#ui/lib/permissions.ts";
import { Diff } from "#ui/components/Diff.tsx";
import { requestErrorText } from "#ui/lib/runs.ts";
import { Chip, DetailActions, DetailHeader, KvRows } from "#ui/components/panes.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { DesktopConfigIssues } from "#ui/components/ConfigIssues.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey, type TFunction } from "#ui/i18n/index.tsx";
import { groupInbox, shortAgo, type InboxDone, type InboxItem } from "#ui/lib/inbox.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { docOwner } from "#ui/lib/scope.ts";
import { useInbox } from "#ui/shell/inbox.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { alertDetail, alertTitle } from "./admin/Alerts.tsx";
import { ActionItem } from "#ui/components/LeaderChat.tsx";

// ── Detail blocks (the design's paragraph, list, code, note, pair and key/value blocks) ──

function P({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm/[22px] text-pretty whitespace-pre-wrap text-fg-primary">{children}</p>;
}

function Li({ dot, tone, children }: { dot: string; tone: "ok" | "bad" | "muted"; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm/[22px] text-fg-primary">
      <span className={cn("w-3.5 shrink-0 text-center font-bold", tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : "text-fg-muted")}>{dot}</span>
      <span>{children}</span>
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle bg-code">
      <div className="flex h-7 items-center border-b border-line-subtle pr-1.5 pl-3 font-mono text-[11px]/none font-medium text-fg-muted">
        <span className="min-w-0 flex-1 truncate">{lang}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t("common.copied")), () => undefined)}
          className="flex h-[22px] cursor-pointer items-center gap-1 rounded-xs px-1.5 font-sans text-[11px]/none font-medium text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
        >
          <Copy className="size-3" />
          {t("common.copy")}
        </button>
      </div>
      <pre className="m-0 max-h-80 overflow-auto px-3 py-2.5 font-mono text-xs/[19px] whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere]">{text}</pre>
    </div>
  );
}

function Note({ tone, children }: { tone: "info" | "warning" | "danger"; children: ReactNode }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  const cls = { info: "bg-info-soft border-info-line text-info", warning: "bg-warning-soft border-warning-line text-warning", danger: "bg-danger-soft border-danger-line text-danger" }[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-md border px-3 py-2.5", cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="text-[13px]/5 text-fg-strong">{children}</span>
    </div>
  );
}

function MemoryCard({ m, t }: { m: Memory; t: TFunction }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line-default bg-surface p-3">
      <span className="font-mono text-xs/none font-semibold text-fg-strong">#{m.id}</span>
      <span className="text-[13px]/5 whitespace-pre-wrap text-fg-primary">{m.content}</span>
      <span className="text-[11px]/[14px] text-fg-muted">
        {m.author} · {formatTime(m.createdAt)} · {t("inbox.conflict.used", { n: m.useCount })}
      </span>
    </div>
  );
}

/** "task.create" → its label (a dot in a message key reads as one more level). */
const leaderKind = (a: ChatAction, t: TFunction) => t(`chat.autoKind.${a.kind.replace(".", "_")}` as MessageKey);

/** What a leader's action is about: the task, run, plan or tool it names. */
function leaderSubject(a: ChatAction): string {
  const i = a.input as Record<string, unknown>;
  const pick = [i.title && i.id ? `${String(i.id)} ${String(i.title)}` : null, i.taskId, i.id, i.runId, i.profileId, i.name, i.itemId].find((v) => typeof v === "string" && v);
  return typeof pick === "string" ? pick : a.project;
}

/** The pass and changes buttons a gate shows, as on the flow card: a flow's step, or a task's review, fix or merge. */
function gateLabels(g: SdlcGateRecord, t: TFunction): { pass: string; changes: string; noteRequired: boolean } {
  if (g.gate === "review" || g.gate === "fix" || g.gate === "merge")
    return { pass: t(`flow.taskPass.${g.gate}`), changes: t(`flow.taskChanges.${g.gate}`), noteRequired: g.gate === "review" };
  return { pass: t(`flow.pass.${g.gate === "tasks" ? "tasks" : g.gate === "dispatch" ? "dispatch" : "next"}`), changes: t("flow.changes"), noteRequired: true };
}

// ── What each kind shows and can do ──

interface Action {
  label: string;
  kind: "primary" | "secondary" | "ghost" | "danger";
  run: () => void | Promise<void>;
}

const firstLine = (s: string, max = 90) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function titleOf(item: InboxItem, t: TFunction): string {
  switch (item.kind) {
    case "plan": return t("planApproval.inboxTitle", { id: item.plan.taskId, title: item.plan.taskTitle });
    case "agentHold": return t("assignment.stopped", { id: item.task.id });
    case "ci": {
      const mr = item.run.mrIid ? t("inbox.ci.mr", { iid: item.run.mrIid }) : "MR";
      const jobs = item.run.ciFix?.jobs.map((j) => j.name).join(", ");
      return jobs ? t("inbox.ci.title", { mr, jobs }) : t("inbox.ci.titleNoJobs", { mr });
    }
    case "waitingRun": return t("inbox.waitingRun.title", { id: item.run.taskId, title: item.run.taskTitle });
    case "cleanup": return firstLine(item.proposal.reason);
    case "proposal":
      return firstLine(item.proposal.reason) || item.proposal.docKey;
    case "review":
      return t("inbox.review.title", { id: item.task.id, title: item.task.title });
    case "memory":
      return firstLine(item.memory.content);
    case "conflict":
      return t("inbox.conflict.title", { a: item.memory.id, b: item.other.id });
    case "machine":
      return t("inbox.machine.title", { label: item.item.label, state: t(`setupState.${item.item.state}`) });
    case "request":
      return t("inbox.request.title", { who: item.command.requestedBy, label: item.command.label });
    case "alert":
      return alertTitle(t, item.alert);
    case "hubIssue": return t(`inbox.hubIssue.${item.issue}.title`, { detail: firstLine(item.detail, 80) });
    case "releaseFailure": return `${t(item.task.id.startsWith("OPS-release-log-") ? "autoRelease.warning" : "autoRelease.failed")} · ${item.task.id}`;
    case "gate":
      return t("inbox.gate.title", { gate: t(`sdlc.gate.${item.gate.gate}`), task: item.gate.taskId });
    case "leader":
      return t("inbox.leader.title", { kind: leaderKind(item.action, t), subject: leaderSubject(item.action) });
  }
}

function metaOf(item: InboxItem, t: TFunction): string {
  switch (item.kind) {
    case "plan": return t("planApproval.revision", { n: item.plan.revision });
    case "agentHold": return requestErrorText(item.task.agent!.hold!);
    case "ci": {
      const f = item.run.ciFix;
      if (!f) return t("inbox.ci.noFix");
      const live = item.run.status === "running" || item.run.status === "queued";
      return live ? t("inbox.ci.fixing", { profile: item.run.profileId ?? "agent", n: f.n, max: f.max }) : t("inbox.ci.fixed", { n: f.n, max: f.max });
    }
    case "waitingRun": return [t(`inbox.waitingRun.reason.${item.reason}`), item.run.machine, item.run.profileId].filter(Boolean).join(" · ");
    case "cleanup": return t("cleanup.source", { id: item.proposal.runId });
    case "proposal":
      return t("inbox.proposal.meta", { author: item.proposal.author, from: item.proposal.baseVersion, to: item.proposal.baseVersion + 1 });
    case "review": {
      const r = item.run;
      if (!r) return item.task.owner ?? firstLine(item.task.note ?? "", 60);
      return [r.mrIid ? t("inbox.ci.mr", { iid: r.mrIid }) : null, r.pipelineStatus ? t("inbox.review.ci", { state: t(`pipelineStatus.${r.pipelineStatus}`) }) : null, r.profileId]
        .filter(Boolean)
        .join(" · ");
    }
    case "memory":
      return t("inbox.memory.meta", { author: item.memory.author });
    case "conflict":
      return t("inbox.conflict.meta", { a: item.memory.id });
    case "machine":
      return t("inbox.machine.meta");
    case "request":
      return t("inbox.request.meta");
    case "alert":
      return alertDetail(t, item.alert);
    case "hubIssue": return firstLine(item.detail, 80);
    case "releaseFailure": return firstLine(item.task.note ?? "", 80);
    case "gate":
      return item.gate.status === "escalated" ? t("inbox.gate.metaEscalated") : t("inbox.gate.meta", { mode: t(`sdlc.mode.${item.gate.mode}`) });
    case "leader":
      return firstLine(item.action.reason, 80);
  }
}

/** "8 ph trước", or "vừa xong" alone; "" when the time is unknown. */
function longAgo(iso: string, now: number, t: TFunction): string {
  const when = shortAgo(iso, now, t);
  return !when || when === t("inbox.ago.now") ? when : t("inbox.agoLong", { when });
}

function scopeText(item: InboxItem, t: TFunction): string {
  return item.kind === "leader" && item.action.project === HUB_SCOPE ? t("chat.actionHub") : item.scope || t("inbox.shared");
}

export function TodayPage() {
  const inbox = useInbox();
  const t = useT();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [sel, setSel] = useState<string | null>(() => new URLSearchParams(window.location.hash.split("?")[1]).get("item"));
  const mobileDetail = useMobileDetail("item");
  const pick = (key: string | null) => {
    setSel(key);
    if (mobileDetail.mobile) mobileDetail.navigate(key);
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    return visibleInterval(60_000, () => setNow(Date.now()));
  }, []);
  // The inbox lives in the shell and polls every 30 s; opening Hôm nay must not show what it fetched up to 30 s ago.
  const reloadInbox = inbox.reload;
  useEffect(() => { reloadInbox(); }, [reloadInbox]);

  const groups = useMemo(() => groupInbox(inbox.items, inbox.role), [inbox.items, inbox.role]);
  // J / K and the first item follow the groups as shown, not the newest-first order they came in.
  const list = useMemo(() => (tab === "open" ? groups.flatMap((g) => g.items) : []), [tab, groups]);
  const selected = mobileDetail.mobile ? mobileDetail.value : sel;
  const current = tab === "open" ? (list.find((i) => i.key === selected) ?? (mobileDetail.mobile ? null : list[0] ?? null)) : null;
  const contextTask = current?.kind === "review" || current?.kind === "agentHold" ? current.task
    : current?.kind === "plan" ? { id: current.plan.taskId, project: current.plan.project }
    : current?.kind === "gate" ? { id: current.gate.taskId, project: current.gate.project } : null;
  const contextRun = current?.kind === "ci" ? { id: current.run.id, project: current.run.project, link: current.run.id }
    : current?.kind === "waitingRun" ? { id: current.run.runId, project: current.run.project, link: `${current.run.machineId}/${current.run.runId}` } : null;
  useChatPageContext(contextRun ? { id: contextRun.id, project: contextRun.project, href: `#/runs?run=${encodeURIComponent(contextRun.link)}` }
    : contextTask ? { id: contextTask.id, project: contextTask.project, href: `#/tasks?task=${encodeURIComponent(contextTask.id)}` } : null);
  const doneCurrent = tab === "done" ? (inbox.done.find((d) => d.key === selected) ?? (mobileDetail.mobile ? null : inbox.done[0] ?? null)) : null;
  useEffect(() => {
    if (!mobileDetail.mobile || !mobileDetail.value) return;
    if (inbox.done.some((d) => d.key === mobileDetail.value)) setTab("done");
    else if (inbox.items.some((i) => i.key === mobileDetail.value)) setTab("open");
  }, [mobileDetail.mobile, mobileDetail.value, inbox.done, inbox.items]);

  useEffect(() => {
    if (current) inbox.markRead(current.key);
  }, [current, inbox]);

  // The action buttons of the item on screen, so ↵ can run the first one.
  // Detail builds fresh closures each render. Publishing them into state feeds an endless parent/child render loop.
  const actions = useRef<Action[]>([]);
  const setActions = useCallback((next: Action[]) => { actions.current = next; }, []);
  const keys = useMemo(() => (tab === "open" ? list.map((i) => i.key) : inbox.done.map((d) => d.key)), [tab, list, inbox.done]);
  const selKey = current?.key ?? doneCurrent?.key ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Global inbox shortcuts must not swallow Enter on links or activate actions behind a dialog.
      if (el && (el.isContentEditable || el.closest('a, button, input, textarea, select, summary, nav, [role="dialog"], [role="menu"]'))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const i = selKey ? keys.indexOf(selKey) : -1;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (keys[i + 1]) setSel(keys[i + 1]!);
      } else if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (i > 0) setSel(keys[i - 1]!);
      } else if (k === "e" && current) {
        e.preventDefault();
        seen(current);
      } else if (e.key === "Enter" && current && actions.current[0]) {
        e.preventDefault();
        void actions.current[0].run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toast = useToast();
  const next = (key: string) => {
    const i = keys.indexOf(key);
    pick(keys[i + 1] ?? keys[i - 1] ?? null);
  };
  const finish = (item: InboxItem, note: string, undoable = false) => {
    next(item.key);
    inbox.markDone({ key: item.key, kind: item.kind, tone: item.tone, title: titleOf(item, t), scope: scopeText(item, t), note });
    toast(note, undoable ? { undo: () => inbox.reopen(item.key) } : undefined);
  };
  const seen = (item: InboxItem) => finish(item, t("inbox.seenNote"), true);

  return (
    <div className="mobile-master-detail flex h-full min-h-0 w-full bg-surface">
      <div className={cn("min-w-0 flex-1 flex-col border-r border-line-subtle md:flex md:min-w-[280px] md:flex-none md:shrink md:basis-[360px]", mobileDetail.showingDetail ? "hidden" : "flex")}>
        <div data-today-reminders className="flex shrink-0 flex-col gap-3 border-b border-line-subtle p-3 [&:not(:has(>*))]:hidden">
          <StartReminder className="" />
          <DesktopConfigIssues />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-[9px]">
          <div role="tablist" className="flex gap-0.5 rounded-[7px] bg-sunken p-0.5">
            {(
              [
                ["open", t("inbox.open"), inbox.items.length],
                ["done", t("inbox.done"), inbox.done.length],
              ] as const
            ).map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => {
                  setTab(k);
                  pick(null);
                }}
                className={cn(
                  "h-6 cursor-pointer rounded-[5px] px-2.5 text-xs/none font-semibold whitespace-nowrap outline-none focus-visible:focus-ring",
                  tab === k ? "bg-surface text-fg-strong shadow-e1" : "text-fg-secondary",
                )}
              >
                {label} <span className="font-normal text-fg-muted">{n}</span>
              </button>
            ))}
          </div>
          {tab === "open" && groups.length > 1 ? (
            <span className="ml-auto min-w-0 truncate text-[11px]/4 text-fg-muted" data-inbox-role={inbox.role}>
              {t("inbox.orderBy", { role: t(`projectRole.${inbox.role}`) })}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div role="listbox" aria-label={t("inbox.listLabel")}>
          {tab === "open"
            ? groups.map(({ group, items }) => (
                <div key={group} role="group" aria-labelledby={`inbox-group-${group}`} data-inbox-group={group}>
                  <div id={`inbox-group-${group}`} className="flex items-center gap-1.5 border-b border-line-subtle bg-subtle px-3.5 py-1.5 text-[11px]/4 font-semibold text-fg-secondary">
                    <span className="min-w-0 flex-1 truncate">{t(`inbox.group.${group}`)}</span>
                    <span className="font-normal text-fg-muted">{items.length}</span>
                  </div>
                  {items.map((item) => {
                    const on = item.key === current?.key;
                    const unread = !inbox.read.has(item.key) && !on;
                    return (
                      <div
                        key={item.key}
                        role="option"
                        aria-selected={on}
                        data-inbox-key={item.key}
                        onClick={() => pick(item.key)}
                        className={cn(
                          "relative flex cursor-pointer flex-col gap-1 border-b border-line-subtle py-2.5 pr-3.5 pl-[22px]",
                          on ? "bg-selected" : "hover:bg-hover",
                        )}
                      >
                        {unread ? <span aria-label={t("inbox.unread")} className="absolute top-[17px] left-[9px] size-[7px] rounded-full bg-info-solid" /> : null}
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Chip kind={item.tone}>{t(`inbox.tag.${item.kind}`)}</Chip>
                          <span className="min-w-0 flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong">{titleOf(item, t)}</span>
                          <span className={cn("shrink-0 text-[11px]/none", on ? "text-fg-secondary" : "text-fg-muted")}>{shortAgo(item.at, now, t)}</span>
                        </div>
                        <span className={cn("truncate text-xs/4", on ? "text-fg-secondary" : "text-fg-muted")}>
                          <span className="font-mono">{scopeText(item, t)}</span>
                          {metaOf(item, t) ? ` · ${metaOf(item, t)}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))
            : inbox.done.map((d) => (
                <div
                  key={d.key}
                  role="option"
                  aria-selected={d.key === doneCurrent?.key}
                  onClick={() => pick(d.key)}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 border-b border-line-subtle py-2.5 pr-3.5 pl-[22px]",
                    d.key === doneCurrent?.key ? "bg-selected" : "hover:bg-hover",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Chip kind={d.tone}>{t(`inbox.tag.${d.kind}`)}</Chip>
                    <span className="min-w-0 flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong">{d.title}</span>
                    <span className={cn("shrink-0 text-[11px]/none", d.key === doneCurrent?.key ? "text-fg-secondary" : "text-fg-muted")}>{shortAgo(d.at, now, t)}</span>
                  </div>
                  <span className={cn("truncate text-xs/4", d.key === doneCurrent?.key ? "text-fg-secondary" : "text-fg-muted")}>
                    <span className="font-mono">{d.scope}</span> · {d.note}
                  </span>
                </div>
              ))}
          {(tab === "open" ? list.length : inbox.done.length) === 0 && !inbox.loading ? (
            <div className="px-6 py-10 text-center text-[13px] text-fg-muted">{t("inbox.empty")}</div>
          ) : null}
        </div>
        </div>
        <div data-today-shortcuts className="hidden shrink-0 gap-3.5 border-t border-line-subtle px-3.5 py-[7px] text-[11px]/4 text-fg-muted md:flex">
          <span>{t("inbox.keySelect")}</span>
          <span>{t("inbox.keyMain")}</span>
          <span>{t("inbox.keySeen")}</span>
        </div>
      </div>
      <div className={cn("min-w-0 flex-1 flex-col", mobileDetail.mobile && !mobileDetail.showingDetail ? "hidden md:flex" : "flex")}>
        {mobileDetail.showingDetail ? <MobileBack onClick={() => pick(null)} /> : null}
        <ErrorNote error={inbox.error} />
        {current ? (
          <Detail key={current.key} item={current} now={now} onActions={setActions} finish={finish} seen={seen} />
        ) : doneCurrent ? (
          <DoneDetail entry={doneCurrent} now={now} onReopen={() => inbox.reopen(doneCurrent.key)} />
        ) : (
          <div className="grid flex-1 place-items-center p-6">
            <div className="flex max-w-[320px] flex-col items-center gap-2 text-center">
              <CircleCheck className="size-7 text-success" />
              <span className="text-[15px]/5 font-semibold text-fg-strong">{t("inbox.allDone")}</span>
              <span className="text-[13px]/5 text-fg-muted">{t("inbox.allDoneBody")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DoneDetail({ entry, now, onReopen }: { entry: InboxDone; now: number; onReopen: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader chips={<Chip kind={entry.tone}>{t(`inbox.tag.${entry.kind}`)}</Chip>} scope={entry.scope} when={longAgo(entry.at, now, t)} title={entry.title} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[760px] flex-col gap-3 px-6 pt-[18px] pb-6">
          <P>{t("inbox.doneNote", { note: entry.note })}</P>
        </div>
      </div>
      <DetailActions actions={[{ label: t("inbox.reopen"), kind: "secondary", run: onReopen }]} foot={t("inbox.doneNote", { note: entry.note })} busy={false} />
    </div>
  );
}

function Detail({
  item,
  now,
  onActions,
  finish,
  seen,
}: {
  item: InboxItem;
  now: number;
  onActions: (a: Action[]) => void;
  finish: (item: InboxItem, note: string, undoable?: boolean) => void;
  seen: (item: InboxItem) => void;
}) {
  const { client, bump } = useHive();
  const inbox = useInbox();
  const t = useT();
  const allow = useCan();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What to change, for a gate sent back (the agent works from it).
  const [note, setNote] = useState("");
  const docKey = item.kind === "proposal" ? item.proposal.docKey : null;
  const doc = useQuery(async () => (docKey ? client.call("docs.get", { key: docKey }) : null), [client, docKey]);

  const act = (fn: () => Promise<string | null>): (() => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      const note = await fn();
      if (note === null) return;
      bump();
      inbox.reload();
      finish(item, note);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const open = (url: string | null | undefined) => () => {
    if (url) window.open(url, "_blank", "noopener");
  };
  const go = (hash: string) => () => {
    window.location.hash = hash;
  };
  const seenAction = (label = t("inbox.seen")): Action => ({ label, kind: "ghost", run: () => seen(item) });

  let body: ReactNode = null;
  let actions: Action[] = [];
  switch (item.kind) {
    case "agentHold": {
      const { task } = item;
      body = <P>{requestErrorText(task.agent!.hold!)}</P>;
      actions = [
        ...(allow(task.project, "runDispatch") ? [{ label: t("assignment.retry"), kind: "primary" as const, run: act(async () => {
          await client.call("tasks.assign", { id: task.id, machineId: task.agent!.machineId, profileId: task.agent!.profileId });
          return t("assignment.selected", { n: 1 });
        }) }, { label: t("assignment.releaseHold"), kind: "secondary" as const, run: act(async () => {
          await client.call("tasks.unassign", { id: task.id });
          return t("assignment.holdReleased");
        }) }] : []),
        { label: t("assignment.change"), kind: "secondary", run: go(`#/tasks?task=${encodeURIComponent(task.id)}`) },
      ];
      break;
    }
    case "ci": {
      const r = item.run;
      body = (
        <>
          <P>{t("inbox.ci.body", { branch: r.branch ?? "—", run: r.id })}</P>
          {(r.ciFix?.jobs ?? []).map((j) => (
            <CodeBlock key={j.name} lang={t("inbox.ci.log", { job: j.name })} text={j.log || "—"} />
          ))}
          {r.ciFix ? <Note tone="info">{t("inbox.ci.limit", { max: r.ciFix.max })}</Note> : null}
        </>
      );
      actions = [
        { label: t("inbox.ci.viewRun"), kind: "primary", run: go(`#/runs?run=${encodeURIComponent(r.id)}`) },
        ...(r.mrUrl ? [{ label: t("inbox.ci.openMr"), kind: "secondary" as const, run: open(r.mrUrl) }] : []),
        seenAction(),
      ];
      break;
    }
    case "waitingRun": {
      const r = item.run;
      body = (
        <>
          <P>{t(`inbox.waitingRun.body.${item.reason}`)}</P>
          {item.reason === "quota" && r.error ? <CodeBlock lang={t("inbox.waitingRun.error")} text={r.error} /> : r.summary ? <CodeBlock lang={t("inbox.waitingRun.summary")} text={r.summary} /> : null}
          <KvRows
            rows={[
              [t("inbox.waitingRun.task"), r.taskId, true],
              [t("inbox.waitingRun.machine"), r.machine, true],
              [t("inbox.waitingRun.run"), `${r.runId} · ${r.profileId ?? "—"}`, true],
            ]}
          />
        </>
      );
      actions = [
        { label: t("inbox.waitingRun.open"), kind: "primary", run: go(`#/runs?run=${encodeURIComponent(`${r.machineId}/${r.runId}`)}`) },
        { label: t("inbox.review.openTask"), kind: "secondary", run: go(`#/tasks?task=${encodeURIComponent(r.taskId)}`) },
        seenAction(),
      ];
      break;
    }
    case "cleanup": {
      body = <><P>{item.proposal.reason}</P><P>{t("cleanup.reviewHint")}</P></>;
      actions = [{ label: t("knowledge.pending"), kind: "primary", run: go("#/memory?tab=pending") }, seenAction()];
      break;
    }
    case "proposal": {
      const p = item.proposal;
      const manage = allow(docOwner(p.docKey), approvalOf(p.docKey));
      const stale = doc.data && doc.data.version !== p.baseVersion;
      body = (
        <>
          <P>{t("inbox.proposal.body", { author: p.author, doc: doc.data?.title || p.docKey })}</P>
          {doc.data?.includeInAgents ? <Note tone="info">{t("inbox.proposal.inAgents")}</Note> : null}
          {stale ? <Note tone="warning">{t("proposals.stale", { version: doc.data?.version ?? 0 })}</Note> : null}
          {!manage ? <Note tone="info">{t("inbox.proposal.noRight")}</Note> : null}
          {doc.loading ? null : <Diff before={doc.data?.content ?? ""} after={p.content} />}
        </>
      );
      actions = manage
        ? [
            {
              label: t("inbox.proposal.approve"),
              kind: "primary",
              run: act(async () => {
                await client.call("proposals.approve", { id: p.id });
                return t("inbox.proposal.approved", { doc: p.docKey, version: p.baseVersion + 1 });
              }),
            },
            { label: t("inbox.proposal.openDoc"), kind: "secondary", run: go(knowledgeHref(p.docKey)) },
            {
              label: t("inbox.proposal.reject"),
              kind: "ghost",
              run: act(async () => {
                await client.call("proposals.reject", { id: p.id });
                return t("inbox.proposal.rejected", { doc: p.docKey });
              }),
            },
          ]
        : [{ label: t("inbox.proposal.openDoc"), kind: "secondary", run: go(knowledgeHref(p.docKey)) }, seenAction()];
      break;
    }
    case "review": {
      const { task, run: r } = item;
      body = (
        <>
          {r?.pipelineStatus ? (
            <Li dot={r.pipelineStatus === "success" ? "✓" : r.pipelineStatus === "failed" ? "✗" : "•"} tone={r.pipelineStatus === "success" ? "ok" : r.pipelineStatus === "failed" ? "bad" : "muted"}>
              {t("inbox.review.ci", { state: t(`pipelineStatus.${r.pipelineStatus}`) })}
            </Li>
          ) : null}
          {r?.mrState ? (
            <Li dot="•" tone="muted">
              {t("inbox.review.mr", { state: t(`mrStatus.${r.mrStatus ?? "opened"}`) })}
            </Li>
          ) : null}
          {r ? (
            <Li dot="±" tone="muted">
              {t("inbox.review.byRun", { run: r.id, profile: r.profileId ?? "—" })}
            </Li>
          ) : null}
          <h3 className="m-0 mt-1.5 text-[13px]/[18px] font-semibold text-fg-strong">{t("inbox.review.handoff")}</h3>
          <ReviewArtifacts project={task.project} taskId={task.id} note={task.note?.trim() || t("inbox.review.noNote")} />
        </>
      );
      const canMove = allow(task.project, "codeReview");
      actions = [
        ...(r?.mrUrl ? [{ label: t("inbox.review.openMr"), kind: "primary" as const, run: open(r.mrUrl) }] : []),
        { label: t("inbox.review.openTask"), kind: r?.mrUrl ? "secondary" : "primary", run: go(`#/tasks?task=${encodeURIComponent(task.id)}`) },
        ...(canMove
          ? [
              {
                label: t("inbox.review.toDone"),
                kind: "secondary" as const,
                run: act(async () => {
                  if (!await confirmTaskClose(client, task, t)) return null;
                  await client.call("tasks.update", { id: task.id, status: "done" });
                  return t("inbox.review.movedDone", { id: task.id });
                }),
              },
            ]
          : []),
        { label: t("inbox.review.markReviewed"), kind: "ghost", run: () => finish(item, t("inbox.review.reviewed", { id: task.id }), true) },
      ];
      break;
    }
    case "memory": {
      const m = item.memory;
      body = (
        <>
          <P>{m.content}</P>
          <KvRows
            rows={[
              [t("inbox.memory.kind"), t(`memoryKind.${m.kind}`)],
              [t("inbox.memory.scope"), m.project ?? t("inbox.shared"), true],
              [t("inbox.memory.author"), m.author, true],
              ...(m.taskId ? ([[t("inbox.memory.task"), m.taskId, true]] as Array<[string, string, boolean]>) : []),
            ]}
          />
        </>
      );
      actions = allow(m.project, "memoryApprove")
        ? [
            {
              label: t("inbox.memory.approve"),
              kind: "primary",
              run: act(async () => {
                await client.call("memory.approve", { id: m.id });
                return t("inbox.memory.approved", { id: m.id });
              }),
            },
            {
              label: t("inbox.memory.reject"),
              kind: "ghost",
              run: act(async () => {
                await client.call("memory.remove", { id: m.id });
                return t("inbox.memory.rejected", { id: m.id });
              }),
            },
          ]
        : [seenAction()];
      break;
    }
    case "conflict": {
      const { memory: a, other: b } = item;
      body = (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <MemoryCard m={a} t={t} />
          <MemoryCard m={b} t={t} />
        </div>
      );
      const resolve = (keep: "this" | "other" | "both", note: string) =>
        act(async () => {
          await client.call("memory.resolve", { id: a.id, other: b.id, keep });
          return note;
        });
      actions = allow(a.project, "memoryApprove")
        ? [
            { label: t("inbox.conflict.keep", { id: a.id }), kind: "primary", run: resolve("this", t("inbox.conflict.kept", { id: a.id, other: b.id })) },
            { label: t("inbox.conflict.keep", { id: b.id }), kind: "secondary", run: resolve("other", t("inbox.conflict.kept", { id: b.id, other: a.id })) },
            { label: t("inbox.conflict.both"), kind: "ghost", run: resolve("both", t("inbox.conflict.bothDone", { a: a.id, b: b.id })) },
          ]
        : [seenAction()];
      break;
    }
    case "machine": {
      const s = item.item;
      body = <CodeBlock lang={s.id} text={s.detail} />;
      actions = [
        ...(s.action && client.desktop
          ? [
              {
                label: s.action,
                kind: "primary" as const,
                run: act(async () => {
                  const res = await client.desktop!.installSetup(s.id);
                  if (res.item.state !== "installed") throw new Error(res.output || res.item.detail);
                  return t("inbox.machine.installed", { label: s.label });
                }),
              },
            ]
          : []),
        { label: t("inbox.machine.openSetup"), kind: s.action ? "secondary" : "primary", run: go("#/setup") },
        seenAction(t("inbox.machine.skip")),
      ];
      break;
    }
    case "alert": {
      const a = item.alert;
      body = (
        <>
          <P>{alertDetail(t, a)}</P>
          <KvRows rows={[[t(`alerts.severity.${a.severity}`), formatTime(a.openedAt), false]]} />
        </>
      );
      actions = [
        {
          label: t("alerts.ack"),
          kind: "primary",
          run: act(async () => {
            await client.alerts!.ack(a.id);
            return t("alerts.acked");
          }),
        },
        { label: t("inbox.alert.open"), kind: "secondary", run: go("#/admin?tab=alerts") },
      ];
      break;
    }
    case "hubIssue": {
      body = <P>{item.detail}</P>;
      actions = [{ label: t("inbox.hubIssue.open"), kind: "primary", run: go("#/admin/hub") }, seenAction()];
      break;
    }
    case "plan": {
      const p = item.plan;
      body = <><P>{t("planApproval.intro")}</P>{p.text ? <CodeBlock lang="plan.md" text={p.text} /> : null}{p.deadline ? <P>{t("planApproval.deadline", { time: formatTime(p.deadline) })}</P> : null}<label className="space-y-1 text-sm"><span>{t("planApproval.note")}</span><Textarea className="text-base" rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} data-plan-note /></label></>;
      const decide = (decision: "approve" | "changes") => act(async () => {
        if (decision === "changes" && !note.trim()) throw new Error(t("planApproval.noteRequired"));
        await client.call("runs.decidePlan", { id: p.id, revision: p.revision, decision, note });
        return t(decision === "approve" ? "planApproval.approved" : "planApproval.sentBack");
      });
      actions = [{ label: t("planApproval.approve"), kind: "primary", run: decide("approve") }, { label: t("planApproval.changes"), kind: "secondary", run: decide("changes") }, { label: t("inbox.gate.openTask"), kind: "ghost", run: go(`#/tasks?task=${encodeURIComponent(p.taskId)}`) }];
      break;
    }
    case "releaseFailure": {
      body = <P>{item.task.note}</P>;
      actions = [{ label: t("autoRelease.title"), kind: "primary", run: go(`#/pipeline?project=${encodeURIComponent(item.task.project)}`) }, { label: t("inbox.gate.openTask"), kind: "secondary", run: go(`#/tasks?task=${encodeURIComponent(item.task.id)}`) }, seenAction()];
      break;
    }
    case "gate": {
      const g = item.gate;
      if (g.gate === "release") {
        body = <P>{t("sdlc.gateHint.release")}</P>;
        actions = [{ label: t("autoRelease.title"), kind: "primary", run: go(`#/pipeline?project=${encodeURIComponent(g.project)}`) }];
        break;
      }
      const labels = gateLabels(g, t);
      const what = { gate: t(`sdlc.gate.${g.gate}`), task: g.taskId };
      const may = allow(g.project, g.gate === "test" ? "qaVerify" : g.gate === "review" || g.gate === "merge" ? "codeReview" : "runDispatch");
      body = (
        <>
          <P>{t(g.status === "escalated" ? "flow.escalated" : "flow.waiting", { gate: what.gate, mode: t(`sdlc.mode.${g.mode}`) })}</P>
          {g.note ? <CodeBlock lang={t("inbox.gate.aiNote")} text={g.note} /> : null}
          <KvRows
            rows={[
              [t("inbox.gate.task"), g.taskId, true],
              [t("inbox.gate.mode"), t(`sdlc.mode.${g.mode}`)],
            ]}
          />
          {may ? (
            <Textarea
              rows={3}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              placeholder={labels.noteRequired ? t("flow.notePlaceholder") : t("flow.taskNoteOther")}
              aria-label={t("flow.note")}
            />
          ) : null}
        </>
      );
      const decide = (decision: "pass" | "changes") =>
        act(async () => {
          if (decision === "changes" && labels.noteRequired && !note.trim()) throw new Error(t("inbox.gate.needNote"));
          await client.call("sdlc.decide", { gateId: g.id, decision, note });
          return t(decision === "pass" ? "inbox.gate.passed" : "inbox.gate.changed", what);
        });
      actions = may
        ? [
            { label: labels.pass, kind: "primary", run: decide("pass") },
            { label: labels.changes, kind: "secondary", run: decide("changes") },
            { label: t("inbox.gate.openTask"), kind: "ghost", run: go(`#/tasks?task=${encodeURIComponent(g.taskId)}`) },
          ]
        : [{ label: t("inbox.gate.openTask"), kind: "secondary", run: go(`#/tasks?task=${encodeURIComponent(g.taskId)}`) }, seenAction()];
      break;
    }
    case "leader": {
      const a = item.action;
      body = (
        <>
          <P>{t("inbox.leader.body", { project: a.project })}</P>
          <ul className="m-0 flex list-none flex-col p-0">
            <ActionItem action={a} taskIds={[]} manage={false} onDecided={() => undefined} />
          </ul>
        </>
      );
      const decide = (accept: boolean) =>
        act(async () => {
          await client.call("chat.decide", { actionId: a.id, accept });
          return t(accept ? "inbox.leader.confirmed" : "inbox.leader.dismissed", { kind: leaderKind(a, t) });
        });
      actions = allow(a.project, "chatApprove")
        ? [
            { label: t("chat.confirm"), kind: "primary", run: decide(true) },
            { label: t("inbox.leader.openChat"), kind: "secondary", run: go(`#/chat?thread=${a.threadId}`) },
            { label: t("chat.dismiss"), kind: "ghost", run: decide(false) },
          ]
        : [{ label: t("inbox.leader.openChat"), kind: "secondary", run: go(`#/chat?thread=${a.threadId}`) }, seenAction()];
      break;
    }
    case "request": {
      const c = item.command;
      body = (
        <>
          <P>{t("inbox.request.body", { label: c.label })}</P>
          <KvRows rows={[[c.itemId, formatTime(c.requestedAt), true]]} />
        </>
      );
      const answer = (approve: boolean) =>
        act(async () => {
          await client.desktop!.answerCommand(c.id, approve);
          return t(approve ? "inbox.request.approved" : "inbox.request.declined", { label: c.label });
        });
      actions = client.desktop
        ? [
            { label: t("inbox.request.approve"), kind: "primary", run: answer(true) },
            { label: t("inbox.request.decline"), kind: "ghost", run: answer(false) },
          ]
        : [seenAction()];
      break;
    }
  }

  useEffect(() => {
    onActions(busy ? [] : actions);
    return () => onActions([]);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader chips={<Chip kind={item.tone}>{t(`inbox.tag.${item.kind}`)}</Chip>} scope={scopeText(item, t)} when={longAgo(item.at, now, t)} title={titleOf(item, t)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[760px] flex-col gap-3 px-6 pt-[18px] pb-6">
          {body}
          <ErrorNote error={error} />
        </div>
      </div>
      <DetailActions actions={actions} foot={t("inbox.enterHint")} busy={busy} />
    </div>
  );
}
