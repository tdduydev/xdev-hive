import { ReviewArtifacts } from "#ui/components/Artifacts.tsx";
import { confirmTaskClose } from "#ui/lib/task-close.ts";
import { useChatPageContext } from "#ui/components/ChatSession.tsx";
import { useStartStatus } from "#ui/pages/Start.tsx";
import { knowledgeHref } from "#ui/lib/knowledge.ts";
// Hôm nay (docs/design/hive-2026-10, template dòng 108–230): a card of what needs the person on the left, the
// selected item with its actions on the right. J / K move, ↵ runs the first button, E marks it seen.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { visibleInterval } from "#ui/lib/visible-interval.ts";
import { Copy, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { HUB_SCOPE, isCliActionProposalKey, type ChatAction, type Memory, type SdlcGateRecord } from "@xdev-hive/core";
import { approvalOf } from "#ui/lib/permissions.ts";
import { DiffPanel } from "#ui/components/Diff.tsx";
import { requestErrorText } from "#ui/lib/runs.ts";
import { ErrorNote } from "#ui/components/common.tsx";
import { DesktopConfigIssues } from "#ui/components/ConfigIssues.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { errorMessage, formatTime, hashParam, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey, type TFunction } from "#ui/i18n/index.tsx";
import { groupToday, shortAgo, todayDot, type InboxDone, type InboxItem, type TodayDot } from "#ui/lib/inbox.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { docOwner, scopeProjects } from "#ui/lib/scope.ts";
import { useInbox } from "#ui/shell/inbox.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { cosmicAssets } from "#ui/assets/cosmic.ts";
import { remainingSteps, type StartStep } from "#ui/lib/start.ts";
import { alertDetail, alertTitle } from "#ui/pages/admin/Alerts.tsx";
import { ActionItem } from "#ui/components/LeaderChat.tsx";

// ── Detail blocks (the design's paragraph, check list, code, note, key/value and note-field blocks) ──

const DOT: Record<TodayDot, string> = {
  violet: "bg-(--accent-violet) shadow-[0_0_8px_var(--accent-violet)]",
  blue: "bg-(--accent-blue) shadow-[0_0_8px_var(--accent-blue)]",
  red: "bg-(--accent-red) shadow-[0_0_8px_var(--accent-red)]",
  amber: "bg-(--accent-amber) shadow-[0_0_8px_var(--accent-amber)]",
};
const TONE_DOT: Record<InboxItem["tone"], TodayDot> = { danger: "red", warning: "amber", info: "blue" };

function P({ children }: { children: ReactNode }) {
  return <p className="m-0 max-w-[720px] text-[15px]/6 font-medium text-pretty whitespace-pre-wrap text-fg-secondary">{children}</p>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-[13px]/5 font-semibold text-fg-strong">{children}</h3>;
}

function Li({ dot, tone, children }: { dot: string; tone: "ok" | "bad" | "muted"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[14px]/[22px] font-medium text-fg-secondary">
      <span className={cn("w-[18px] shrink-0 text-center font-bold", tone === "ok" ? "text-(--mark-ok)" : tone === "bad" ? "text-(--mark-bad)" : "text-(--mark-skip)")}>{dot}</span>
      <span>{children}</span>
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="overflow-hidden rounded-[16px] bg-(--surface-sunken) shadow-[var(--ring-glass)]">
      <div className="flex h-9 items-center gap-2 pr-2 pl-3.5 font-mono text-[12px]/none font-medium text-fg-muted shadow-[inset_0_-1px_0_var(--today-rule)]">
        <span className="min-w-0 flex-1 truncate">{lang}</span>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t("common.copied")), () => undefined)}
          className="flex h-6 cursor-pointer items-center gap-1 rounded-[8px] px-1.5 font-sans text-[11px]/none font-semibold text-fg-secondary outline-none hover:bg-(--glass-bg) focus-visible:focus-ring"
        >
          <Copy className="size-3" />
          {t("common.copy")}
        </button>
      </div>
      <pre className="m-0 max-h-80 overflow-auto px-3.5 py-2 font-mono text-[12.5px]/[21px] font-medium whitespace-pre-wrap text-code-fg [overflow-wrap:anywhere]">{text}</pre>
    </div>
  );
}

function Note({ tone, children }: { tone: "info" | "warning" | "danger"; children: ReactNode }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  const cls = { info: "bg-info-soft text-info", warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger" }[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-[14px] px-3.5 py-3 shadow-[var(--ring-glass)]", cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="text-[14px]/[22px] font-medium text-fg-strong">{children}</span>
    </div>
  );
}

function MemoryCard({ m, t }: { m: Memory; t: TFunction }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] bg-(--surface-sunken) px-3.5 py-3 shadow-[var(--ring-glass)]">
      <span className="font-mono text-xs/none font-semibold text-fg-strong">#{m.id}</span>
      <span className="text-[14px]/[22px] font-medium whitespace-pre-wrap text-fg-secondary">{m.content}</span>
      <span className="text-xs/[18px] font-medium text-fg-muted">
        {m.author} · {formatTime(m.createdAt)} · {t("inbox.conflict.used", { n: m.useCount })}
      </span>
    </div>
  );
}

/** Label / value cells of the design (1px gaps over a tinted base, sunken cells). */
function KvRows({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-px overflow-hidden rounded-[16px] bg-(--today-kv-gap) shadow-[var(--ring-glass)]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5 bg-(--surface-sunken) px-3.5 py-3">
          <span className="text-[11px]/4 font-semibold tracking-[0.5px] text-(--text-faint) uppercase">{k}</span>
          <span className="text-[13px]/5 font-medium text-fg-strong [overflow-wrap:anywhere]">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** "Ghi chú gửi kèm": the note a decision carries (the plan's and the gate's). */
function NoteField({ title, value, onChange, placeholder, plan }: { title: string; value: string; onChange: (v: string) => void; placeholder?: string; plan?: boolean }) {
  return (
    <label className="flex flex-col gap-2">
      <SectionTitle>{title}</SectionTitle>
      <textarea
        rows={3}
        value={value}
        maxLength={2000}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-plan-note={plan ? "" : undefined}
        className="min-h-[76px] max-md:text-base resize-y rounded-[14px] bg-(--surface-sunken) px-3.5 py-3 text-[14px]/[22px] font-medium text-fg-strong shadow-[var(--ring-glass)] outline-none placeholder:text-fg-muted focus-visible:focus-ring"
      />
    </label>
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
      return t("inbox.machine.title", { label: item.machine ? `${item.machine} · ${item.item.label}` : item.item.label, state: t(`setupState.${item.item.state}`) });
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
      return isCliActionProposalKey(item.proposal.docKey)
        ? `${item.proposal.author} · ${t("proposals.operation", { id: item.proposal.id })}`
        : t("inbox.proposal.meta", { author: item.proposal.author, from: item.proposal.baseVersion, to: item.proposal.baseVersion + 1 });
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

export function TodayInboxPage() {
  const inbox = useInbox();
  const t = useT();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [sel, setSel] = useState<string | null>(() => hashParam("item"));
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

  const { client, me, scope, projects } = useHive();
  const owners = scope.kind === "shared" ? [] : scopeProjects(scope) ?? projects;
  const remoteSetup = useQuery(async () => {
    if (client.desktop || me.mode !== "hub" || me.role !== "admin" || me.access) return [];
    const missing = await Promise.all(owners.map(async project => ({ project, machines: await client.call("machines.setupMissing", { project }) })));
    const unique = new Map<string, InboxItem>();
    for (const { project, machines } of missing) for (const machine of machines) for (const item of machine.items) {
      const key = `machine:${machine.machineId}:${item.id}:${item.state}`;
      unique.set(key, { kind: "machine", key, scope: project, tone: "warning", at: "", item: { ...item, action: null }, machineId: machine.machineId, machine: machine.machine });
    }
    return [...unique.values()];
  }, [client, me, owners.join("\n"), now]);
  const pageItems = useMemo(() => [...inbox.items, ...(remoteSetup.data ?? []).filter(item => !inbox.done.some(done => done.key === item.key))], [inbox.items, inbox.done, remoteSetup.data]);
  const groups = useMemo(() => groupToday(pageItems), [pageItems]);
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
    else if (pageItems.some((i) => i.key === mobileDetail.value)) setTab("open");
  }, [mobileDetail.mobile, mobileDetail.value, inbox.done, pageItems]);

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
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Global inbox shortcuts must not swallow Enter on links or activate actions behind a dialog.
      if (el && (el.isContentEditable || el.closest('input, textarea, select, nav, [role="dialog"], [role="menu"]'))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Enter" && el?.closest('a, button, summary, [role="option"]')) return;
      const i = selKey ? keys.indexOf(selKey) : -1;
      const k = e.key.toLowerCase();
      const move = (key: string) => {
        pick(key);
        // Keep the listbox's active option and DOM focus together for keyboard and screen reader users.
        if (!mobileDetail.mobile) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(key)}"]`)?.focus());
      };
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (keys[i + 1]) move(keys[i + 1]!);
      } else if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (i > 0) move(keys[i - 1]!);
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

  const startStatus = useStartStatus();
  const [startDismissed, setStartDismissed] = useState(false);
  const startLeft = startStatus.data?.remaining ?? 0;
  const startNext = startStatus.data ? (Object.keys(startStatus.data.steps) as StartStep[]).find((k) => startStatus.data!.steps[k] === "todo") : undefined;
  // Four numbers the inbox already holds (no figure of its own): what waits per group, and what this device settled.
  const summary = [
    ...groups.map(({ group, items }) => ({ id: group, dot: ({ approve: "violet", fix: "red", machine: "amber" } as const)[group], label: t(`inbox.page.group.${group}`), value: items.length, note: longAgo(items.at(-1)!.at, now, t) ? t("inbox.page.oldest", { when: longAgo(items.at(-1)!.at, now, t) }) : "", go: () => { setTab("open"); pick(items[0]!.key); } })),
    { id: "done", dot: "blue" as const, label: t("inbox.page.tabDone"), value: inbox.done.length, note: t("inbox.page.thisDevice"), go: () => { setTab("done"); pick(null); } },
  ];
  const sub = t("inbox.page.sub");
  return (
    <div className="mobile-master-detail flex min-h-full w-full flex-col px-4 pt-6 pb-8 md:px-7">
      <div data-today-reminders className="flex shrink-0 flex-col gap-3 empty:hidden [&:not(:has(>*))]:hidden">
        <DesktopConfigIssues />
      </div>
      <p className="m-0 mb-5 max-w-[760px] text-[14px]/[22px] font-medium text-pretty text-fg-secondary">{sub}</p>
      {startLeft && !startDismissed ? (
        <div className="mb-4 flex flex-wrap items-center gap-3.5 rounded-[20px] bg-(--today-banner-bg) py-3.5 pr-4 pl-[18px] shadow-[var(--today-banner-ring)]">
          <img src={cosmicAssets.planetViolet} alt="" className="size-[34px] rounded-full shadow-[var(--today-banner-glow)]" />
          <span className="flex min-w-[220px] flex-1 flex-col">
            <span className="text-[14px]/5 font-semibold">{t("inbox.page.startLeft", { count: startLeft })}</span>
            {startNext ? <span className="text-xs/[18px] font-medium text-fg-secondary">{t(`start.${startNext}`)}</span> : null}
          </span>
          <Button variant="solid" size="sm" onClick={() => { window.location.hash = "/start"; }}>{t("inbox.page.startOpen")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setStartDismissed(true)}>{t("inbox.page.startLater")}</Button>
        </div>
      ) : null}
      <div data-today-summary className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 max-md:grid-cols-2">
        {summary.map((tile) => (
          <button
            key={tile.id}
            type="button"
            onClick={tile.go}
            className="flex cursor-pointer flex-col gap-1.5 rounded-[20px] bg-(--surface-1) px-[18px] py-4 text-left text-fg-strong shadow-[var(--ring-glass)] outline-none hover:shadow-[var(--ring-glass-strong)] focus-visible:focus-ring"
          >
            <span className="flex items-center gap-2 text-xs/[18px] font-medium text-fg-muted">
              <span className={cn("size-1.5 rounded-full", DOT[tile.dot])} />
              {tile.label}
            </span>
            <span className="text-[30px]/9 font-bold tracking-[-0.4px]">{tile.value}</span>
            <span className="text-xs/[18px] font-medium text-fg-secondary">{tile.note}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <div className={cn("max-w-full min-w-0 flex-[1_1_300px] flex-col overflow-hidden rounded-[24px] bg-(--surface-1) shadow-[var(--ring-glass)] max-md:w-full", mobileDetail.showingDetail ? "hidden" : "flex")}>
          <div className="flex items-center gap-1.5 px-3.5 pt-3.5 pb-2.5">
            <div role="tablist" className="flex gap-1.5">
              {(
                [
                  ["open", t("inbox.page.tabOpen"), pageItems.length],
                  ["done", t("inbox.page.tabDone"), inbox.done.length],
                ] as const
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  data-active={tab === k}
                  onClick={() => {
                    setTab(k);
                    pick(null);
                  }}
                  className="cosmic-tag cursor-pointer outline-none focus-visible:focus-ring"
                >
                  {label} · {n}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <span data-today-shortcuts data-inbox-role={inbox.role} className="hidden text-[11px]/4 font-semibold text-(--text-faint) md:inline">{t("inbox.page.keys")}</span>
          </div>
          <div role="listbox" aria-label={t("inbox.listLabel")}>
            {tab === "open"
              ? groups.map(({ group, items }) => (
                  <div key={group} role="group" aria-labelledby={`inbox-group-${group}`} data-inbox-group={group} className="flex flex-col">
                    <div id={`inbox-group-${group}`} className="px-[18px] pt-3 pb-1.5 text-[11px]/4 font-semibold tracking-[0.6px] text-(--text-faint) uppercase">
                      {t(`inbox.page.group.${group}`)} · {items.length}
                    </div>
                    {items.map((item) => (
                      <Row
                        key={item.key}
                        itemKey={item.key}
                        on={item.key === current?.key}
                        tabStop={item.key === (current?.key ?? list[0]?.key)}
                        dot={todayDot(item)}
                        title={titleOf(item, t)}
                        scope={scopeText(item, t)}
                        meta={metaOf(item, t)}
                        age={shortAgo(item.at, now, t)}
                        onPick={() => pick(item.key)}
                      />
                    ))}
                  </div>
                ))
              : inbox.done.map((d) => (
                  <Row
                    key={d.key}
                    itemKey={d.key}
                    on={d.key === doneCurrent?.key}
                    tabStop={d.key === (doneCurrent?.key ?? inbox.done[0]?.key)}
                    dot={TONE_DOT[d.tone]}
                    title={d.title}
                    scope={d.scope}
                    meta={d.note}
                    age={shortAgo(d.at, now, t)}
                    onPick={() => pick(d.key)}
                  />
                ))}
            {(tab === "open" ? list.length : inbox.done.length) === 0 && !inbox.loading ? (
              <div className="px-6 py-10 text-center text-[14px]/[22px] font-medium text-fg-muted">{t("inbox.page.empty")}</div>
            ) : null}
          </div>
          <div className="h-2.5" />
        </div>
        <div data-today-detail className={cn("min-w-0 flex-[999_1_440px] flex-col gap-3", mobileDetail.mobile && !mobileDetail.showingDetail ? "hidden" : "flex", !current && !doneCurrent && !mobileDetail.showingDetail && "md:hidden")}>
          {mobileDetail.showingDetail ? <MobileBack onClick={() => pick(null)} /> : null}
          <ErrorNote error={inbox.error ?? remoteSetup.error} />
          {current ? (
            <Detail key={current.key} item={current} now={now} onActions={setActions} finish={finish} seen={seen} />
          ) : doneCurrent ? (
            <DoneDetail entry={doneCurrent} now={now} onReopen={() => inbox.reopen(doneCurrent.key)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ itemKey, on, tabStop, dot, title, scope, meta, age, onPick }: { itemKey: string; on: boolean; tabStop: boolean; dot: TodayDot; title: string; scope: string; meta: string; age: string; onPick: () => void }) {
  return (
    <div
      role="option"
      aria-selected={on}
      tabIndex={tabStop ? 0 : -1}
      data-inbox-key={itemKey}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={cn(
        "mx-2 grid cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] px-2.5 py-3 text-left outline-none focus-visible:focus-ring",
        on ? "bg-(--today-row-selected-bg) shadow-[var(--today-row-selected-ring)]" : "hover:bg-(--glass-bg)",
      )}
    >
      <span className={cn("mt-1.5 size-2 rounded-full", DOT[dot])} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[13.5px]/[19px] font-semibold text-pretty text-fg-strong">{title}</span>
        <span className="truncate text-xs/[18px] font-medium text-fg-muted">
          {scope}
          {meta ? ` · ${meta}` : ""}
        </span>
      </span>
      <span className="pt-0.5 text-[11px]/4 font-semibold text-(--text-faint)">{age}</span>
    </div>
  );
}

const VARIANT = { primary: "solid", secondary: "glass", ghost: "ghost", danger: "glass" } as const;

/** The design's detail card: pill and age, title, the item's blocks, then its buttons (the first runs on ↵). */
function DetailCard({ dot, kind, scope, when, title, children, actions, busy, foot }: { dot: TodayDot; kind: string; scope: string; when: string; title: string; children?: ReactNode; actions: Action[]; busy: boolean; foot?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-5 rounded-[24px] bg-(--surface-1) px-4 pt-5 pb-5 shadow-[var(--ring-glass)] md:px-7 md:pt-6 md:pb-[26px] [&>header+p]:-mt-2.5">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-(--glass-bg) px-2.5 text-[11px]/4 font-semibold text-fg-secondary shadow-[var(--ring-glass)]">
            <span className={cn("size-1.5 rounded-full", DOT[dot])} />
            {kind}
          </span>
          <span className="text-xs/[18px] font-medium text-fg-muted">{[scope, when].filter(Boolean).join(" · ")}</span>
        </div>
        <h2 className="m-0 text-[24px]/8 font-bold tracking-[-0.2px] text-pretty text-fg-strong [overflow-wrap:anywhere]">{title}</h2>
      </header>
      {children}
      <div data-today-actions className="flex flex-wrap items-center gap-2.5 pt-1">
        {actions.map((a) => (
          <Button key={a.label} variant={VARIANT[a.kind]} size="md" disabled={busy} onClick={() => void a.run()}>
            {a.label}
          </Button>
        ))}
        <span className="flex-1" />
        {foot ? <span className="hidden text-[11px]/4 font-semibold text-(--text-faint) md:inline">{foot}</span> : null}
      </div>
    </div>
  );
}

function DoneDetail({ entry, now, onReopen }: { entry: InboxDone; now: number; onReopen: () => void }) {
  const t = useT();
  return (
    <DetailCard dot={TONE_DOT[entry.tone]} kind={t(`inbox.tag.${entry.kind}`)} scope={entry.scope} when={longAgo(entry.at, now, t)} title={entry.title} actions={[{ label: t("inbox.reopen"), kind: "secondary", run: onReopen }]} busy={false}>
      <P>{t("inbox.doneNote", { note: entry.note })}</P>
    </DetailCard>
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
  const { client, bump, me } = useHive();
  const inbox = useInbox();
  const t = useT();
  const allow = useCan();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // What to change, for a gate sent back (the agent works from it).
  const [note, setNote] = useState("");
  const docKey = item.kind === "proposal" && !isCliActionProposalKey(item.proposal.docKey) ? item.proposal.docKey : null;
  const doc = useQuery(async () => (docKey ? client.call("docs.get", { key: docKey }) : null), [client, docKey]);

  const act = (fn: () => Promise<string | null>): (() => Promise<void>) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
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

  const stopCi = (project: string, mrUrl: string | null): Action[] => mrUrl && allow(project, "runDispatch") ? [{
    label: t("inbox.ci.stop"), kind: "ghost", run: act(async () => {
      if (!window.confirm(t("inbox.ci.stopConfirm"))) return null;
      await client.call("runs.stopCi", { project, mrUrl });
      return t("inbox.ci.stopped");
    }),
  }] : [];

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
        ...stopCi(r.project, r.mrUrl),
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
        ...(item.reason === "ci" ? stopCi(r.project, r.mrUrl) : []),
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
      if (isCliActionProposalKey(p.docKey)) {
        body = <><P>{p.reason}</P><Note tone="warning">{t("proposals.operationApproval")}</Note></>;
        actions = [{ label: t("inbox.proposal.reviewOperation"), kind: "primary", run: go("#/proposals") }, seenAction()];
        break;
      }
      const manage = allow(docOwner(p.docKey), approvalOf(p.docKey));
      const stale = doc.data && doc.data.version !== p.baseVersion;
      body = (
        <>
          <P>{t("inbox.proposal.body", { author: p.author, doc: doc.data?.title || p.docKey })}</P>
          {doc.data?.includeInAgents ? <Note tone="info">{t("inbox.proposal.inAgents")}</Note> : null}
          {stale ? <Note tone="warning">{t("proposals.stale", { version: doc.data?.version ?? 0 })}</Note> : null}
          {!manage ? <Note tone="info">{t("inbox.proposal.noRight")}</Note> : null}
          {doc.loading ? null : <DiffPanel before={doc.data?.content ?? ""} after={p.content} file={p.docKey} />}
        </>
      );
      actions = manage
        ? [
            {
              label: t("inbox.proposal.approve"),
              kind: "primary",
              run: act(async () => {
                const result = await client.call("proposals.approve", { id: p.id });
                if (result.status !== "approved") throw new Error(t("proposals.stale", { version: doc.data?.version ?? 0 }));
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
      const { task, run: r, hubRun } = item;
      const mrUrl = hubRun?.mrUrl ?? r?.mrUrl;
      body = (
        <>
          {hubRun ? <P>{[hubRun.mrUrl, hubRun.mr?.pipeline ? t("inbox.review.ci", { state: t(`pipelineStatus.${hubRun.mr.pipeline}`) }) : null, hubRun.summary].filter(Boolean).join("\n")}</P> : null}
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
          <NoteField title={t("inbox.page.noteTitle")} value={note} onChange={setNote} placeholder={t("flow.notePlaceholder")} />
          <SectionTitle>{t("inbox.review.handoff")}</SectionTitle>
          <ReviewArtifacts project={task.project} taskId={task.id} note={task.note?.trim() || t("inbox.review.noNote")} />
        </>
      );
      const canMove = allow(task.project, "codeReview");
      actions = [
        ...(canMove && hubRun?.mrUrl && (!hubRun.mr?.status || hubRun.mr.status === "opened") && !hubRun.mr?.draft && hubRun.mr?.pipeline !== "failed" && hubRun.merge?.status !== "pending" ? [{
          label: t("inbox.review.merge"), kind: "primary" as const, run: act(async () => {
            if (!window.confirm(t("inbox.review.mergeConfirm", { mr: hubRun.mrUrl! }))) return null;
            await client.call("runs.merge", { machineId: hubRun.machineId, runId: hubRun.runId });
            return t("inbox.review.mergeRequested");
          }),
        }] : []),
        ...(canMove ? [{ label: t("inbox.review.changes"), kind: "secondary" as const, run: act(async () => {
          if (!note.trim()) throw new Error(t("inbox.gate.needNote"));
          await client.call("tasks.requestChanges", { id: task.id, note });
          return t("inbox.review.changesRequested", { id: task.id });
        }) }] : []),
        ...(mrUrl ? [{ label: t("inbox.review.openMr"), kind: "secondary" as const, run: open(mrUrl) }] : []),
        { label: t("inbox.review.openTask"), kind: mrUrl ? "secondary" : "primary", run: go(`#/tasks?task=${encodeURIComponent(task.id)}`) },
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
            ...(m.project !== null && allow(null, "memoryApprove") ? [{
              label: t("inbox.memory.share"), kind: "secondary" as const, run: act(async () => {
                if (!window.confirm(t("inbox.memory.shareConfirm"))) return null;
                await client.call("memory.share", { id: m.id });
                return t("inbox.memory.shared", { id: m.id });
              }),
            }] : []),
            {
              label: t("inbox.memory.reject"),
              kind: "ghost",
              run: act(async () => {
                if (!window.confirm(t("inbox.memory.removeConfirm", { id: m.id }))) return null;
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
          if (keep !== "both" && !window.confirm(t("inbox.conflict.confirm", { id: keep === "this" ? a.id : b.id, other: keep === "this" ? b.id : a.id }))) return null;
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
        ...(item.machineId && me.role === "admin" && !me.access ? [{
          label: t("inbox.machine.installRemote"), kind: "primary" as const, run: act(async () => {
            if (!window.confirm(t("inbox.machine.installConfirm", { machine: item.machine! }))) return null;
            await client.call("admin.commandCreate", { machineId: item.machineId!, itemId: s.id });
            return t("inbox.machine.installRequested", { machine: item.machine! });
          }),
        }] : []),
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
        ...(!item.machineId ? [{ label: t("inbox.machine.openSetup"), kind: "secondary" as const, run: go("#/setup") }] : []),
        item.machineId ? { label: t("inbox.proposal.reject"), kind: "ghost", run: () => finish(item, t("inbox.machine.installDeclined", { label: s.label }), true) } : seenAction(t("inbox.machine.skip")),
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
      body = <><P>{t("planApproval.intro")}</P>{p.text ? <CodeBlock lang="plan.md" text={p.text} /> : null}{p.deadline ? <P>{t("planApproval.deadline", { time: formatTime(p.deadline) })}</P> : null}<NoteField title={t("planApproval.note")} value={note} onChange={setNote} plan /></>;
      const decide = (decision: "approve" | "changes") => act(async () => {
        if (decision === "changes" && !note.trim()) throw new Error(t("planApproval.noteRequired"));
        await client.call("runs.decidePlan", { id: p.id, revision: p.revision, decision, note });
        return t(decision === "approve" ? "planApproval.approved" : "planApproval.sentBack");
      });
      actions = allow(p.project, "runDispatch") ? [{ label: t("planApproval.approve"), kind: "primary", run: decide("approve") }, { label: t("planApproval.changes"), kind: "secondary", run: decide("changes") }, { label: t("inbox.gate.openTask"), kind: "ghost", run: go(`#/tasks?task=${encodeURIComponent(p.taskId)}`) }] : [seenAction()];
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
          {may ? <NoteField title={t("inbox.page.noteTitle")} value={note} onChange={setNote} placeholder={labels.noteRequired ? t("flow.notePlaceholder") : t("flow.taskNoteOther")} /> : null}
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
    <DetailCard dot={todayDot(item)} kind={t(`inbox.tag.${item.kind}`)} scope={scopeText(item, t)} when={longAgo(item.at, now, t)} title={titleOf(item, t)} actions={actions} busy={busy} foot={t("inbox.page.foot")}>
      {body}
      <ErrorNote error={error} />
    </DetailCard>
  );
}
