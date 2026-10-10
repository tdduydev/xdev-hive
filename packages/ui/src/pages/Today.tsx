import { ReviewArtifacts } from "#ui/components/Artifacts.tsx";
import { taskCloseWarning } from "#ui/lib/task-close.ts";
import { useChatPageContext } from "#ui/components/ChatSession.tsx";
import { useStartStatus } from "#ui/pages/Start.tsx";
import { knowledgeHref } from "#ui/lib/knowledge.ts";
// Hôm nay (docs/design/hive-2026-10, template dòng 108–230): what needs the person on the left in three sections
// (lib/inbox.ts inboxSection), the selected item with its actions on the right. J / K move, ↵ runs the main button,
// E marks it seen. Nothing asks "are you sure": an action runs at once and, where it can be taken back, offers
// Hoàn tác for a few seconds instead (see Detail).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { visibleInterval } from "#ui/lib/visible-interval.ts";
import { CircleCheckBig, Copy, Ellipsis, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { HUB_SCOPE, isCliActionProposalKey, type ChatAction, type Memory, type SdlcGateRecord } from "@xdev-hive/core";
import { approvalOf } from "#ui/lib/permissions.ts";
import { DiffPanel } from "#ui/components/Diff.tsx";
import { requestErrorText } from "#ui/lib/runs.ts";
import { ErrorNote } from "#ui/components/common.tsx";
import { DesktopConfigIssues } from "#ui/components/ConfigIssues.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey, type TFunction } from "#ui/i18n/index.tsx";
import { groupSections, shortAgo, todayDot, type InboxDone, type InboxItem, type InboxSection, type TodayDot } from "#ui/lib/inbox.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { docOwner, scopeProjects } from "#ui/lib/scope.ts";
import { useInbox } from "#ui/shell/inbox.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@xdev-hive/ui/components/ui/dropdown-menu";
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
  return <p className="m-0 max-w-[720px] text-[15px]/6 font-medium text-pretty whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{children}</p>;
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

/** How long Hoàn tác stays on screen, and how long a send without a hub-side undo is held back. */
const UNDO_MS = 5000;

/**
 * Sends held back for their undo window, by inbox key. Module-level, not component state: leaving Hôm nay inside the
 * window must still send, not drop the person's decision with the unmounted page.
 */
const held = new Map<string, { timer: ReturnType<typeof setTimeout>; send: () => void }>();

/** Sends after UNDO_MS unless the returned cancel runs first; cancel says whether it was still in time. */
function holdSend(key: string, send: () => Promise<void>, failed: (err: unknown) => void): () => boolean {
  const run = () => {
    held.delete(key);
    send().catch(failed);
  };
  held.set(key, { timer: setTimeout(run, UNDO_MS), send: run });
  return () => {
    const h = held.get(key);
    if (!h) return false;
    clearTimeout(h.timer);
    held.delete(key);
    return true;
  };
}

// Closing the tab inside the window sends at once: a decision the person made and did not undo must not be lost.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const h of [...held.values()]) {
      clearTimeout(h.timer);
      h.send();
    }
  });
}

type Undo = () => void | Promise<void>;

const SECTION_ICON: Record<InboxSection, typeof Info> = { decide: CircleCheckBig, fix: TriangleAlert, fyi: Info };

export function TodayInboxPage() {
  const inbox = useInbox();
  const t = useT();
  const [tab, setTab] = useState<"open" | "done">("open");
  // The selection lives in the address (?item=…): a link opens the item, and on a phone Back returns to the list.
  const route = useMobileDetail("item");
  const mobile = route.mobile;
  // Whether this page pushed the phone's detail entry: then its back control is the browser's Back, not a new entry.
  const pushed = useRef(false);
  const pick = (key: string | null, how: "open" | "move" = "open") => {
    // On a desktop the selection is not a step of its own: replacing keeps Back leaving the inbox, as people expect.
    const replace = !mobile || how === "move" || key === null;
    if (mobile && !replace) pushed.current = true;
    route.navigate(key, replace);
  };
  const back = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else route.navigate(null, true);
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
  const sections = useMemo(() => groupSections(pageItems), [pageItems]);
  // J / K and the first item follow the sections as shown, not the newest-first order they came in.
  const list = useMemo(() => (tab === "open" ? sections.flatMap((s) => s.items) : []), [tab, sections]);
  const selected = route.value;
  const current = tab === "open" ? (list.find((i) => i.key === selected) ?? (mobile ? null : list[0] ?? null)) : null;
  const contextTask = current?.kind === "review" || current?.kind === "agentHold" ? current.task
    : current?.kind === "plan" ? { id: current.plan.taskId, project: current.plan.project }
    : current?.kind === "gate" ? { id: current.gate.taskId, project: current.gate.project } : null;
  const contextRun = current?.kind === "ci" ? { id: current.run.id, project: current.run.project, link: current.run.id }
    : current?.kind === "waitingRun" ? { id: current.run.runId, project: current.run.project, link: `${current.run.machineId}/${current.run.runId}` } : null;
  useChatPageContext(contextRun ? { id: contextRun.id, project: contextRun.project, href: `#/runs?run=${encodeURIComponent(contextRun.link)}` }
    : contextTask ? { id: contextTask.id, project: contextTask.project, href: `#/tasks?task=${encodeURIComponent(contextTask.id)}` } : null);
  const doneCurrent = tab === "done" ? (inbox.done.find((d) => d.key === selected) ?? (mobile ? null : inbox.done[0] ?? null)) : null;
  // A link to a handled item opens the Đã xong tab, one to an open item the Đang chờ tab.
  useEffect(() => {
    if (!selected) return;
    if (inbox.done.some((d) => d.key === selected)) setTab("done");
    else if (pageItems.some((i) => i.key === selected)) setTab("open");
  }, [selected, inbox.done, pageItems]);

  useEffect(() => {
    if (current) inbox.markRead(current.key);
  }, [current, inbox]);

  // The action buttons of the item on screen, so ↵ can run the main one.
  // Detail builds fresh closures each render. Publishing them into state feeds an endless parent/child render loop.
  const actions = useRef<Action[]>([]);
  const setActions = useCallback((next: Action[]) => { actions.current = next; }, []);
  const keys = useMemo(() => (tab === "open" ? list.map((i) => i.key) : inbox.done.map((d) => d.key)), [tab, list, inbox.done]);
  const selKey = current?.key ?? doneCurrent?.key ?? null;
  // Held J (key repeat) fires faster than React renders: each press moves from the last press's row, not the last render's.
  const selRef = useRef(selKey);
  selRef.current = selKey;

  const listPane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  // The selected row stays in sight as J / K walk past the pane's edge; "nearest" leaves the list still when it is.
  useEffect(() => {
    if (!selKey || mobile) return;
    listPane.current?.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(selKey)}"]`)?.scrollIntoView({ block: "nearest" });
    // A new item reads from its top, whatever the last one was scrolled to.
    detailPane.current?.scrollTo({ top: 0 });
  }, [selKey, mobile]);
  // On a phone the list and the detail share the page's one scroll: the detail opens at its top and Back returns to
  // the row the person left, not to wherever the detail was scrolled.
  const listScroll = useRef(0);
  const showingDetail = route.showingDetail;
  useLayoutEffect(() => {
    if (!mobile) return;
    const main = document.getElementById("hive-main");
    if (!main) return;
    if (showingDetail) main.scrollTop = 0;
    else main.scrollTop = listScroll.current;
  }, [mobile, showingDetail]);
  const open = (key: string) => {
    if (mobile) listScroll.current = document.getElementById("hive-main")?.scrollTop ?? 0;
    pick(key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      // Global inbox shortcuts must not swallow Enter on links or activate actions behind a dialog.
      if (el && (el.isContentEditable || el.closest('input, textarea, select, nav, [role="dialog"], [role="menu"]'))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Enter" && el?.closest('a, button, summary, [role="option"]')) return;
      // Arrows scroll the detail when the person is reading it; J / K move the selection from anywhere.
      const arrows = !el || el === document.body || !!el.closest("[data-today-list]");
      const i = selRef.current ? keys.indexOf(selRef.current) : -1;
      const k = e.key.toLowerCase();
      const move = (key: string) => {
        selRef.current = key;
        pick(key, "move");
        // Keep the listbox's active option and DOM focus together for keyboard and screen reader users.
        if (!mobile) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(key)}"]`)?.focus());
      };
      if (k === "j" || (arrows && e.key === "ArrowDown")) {
        e.preventDefault();
        if (keys[i + 1]) move(keys[i + 1]!);
      } else if (k === "k" || (arrows && e.key === "ArrowUp")) {
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
    pick(keys[i + 1] ?? keys[i - 1] ?? null, "move");
  };
  const finish = (item: InboxItem, note: string, undo?: Undo) => {
    next(item.key);
    inbox.markDone({ key: item.key, kind: item.kind, tone: item.tone, title: titleOf(item, t), scope: scopeText(item, t), note });
    toast(note, undo ? {
      duration: UNDO_MS,
      undo: () => void Promise.resolve(undo()).catch((err: unknown) => toast(errorMessage(err), { tone: "error" })),
    } : undefined);
  };
  const seen = (item: InboxItem) => finish(item, t("inbox.seenNote"), () => inbox.reopen(item.key));

  const startStatus = useStartStatus();
  const [startDismissed, setStartDismissed] = useState(false);
  const startLeft = startStatus.data?.remaining ?? 0;
  const startNext = startStatus.data ? (Object.keys(startStatus.data.steps) as StartStep[]).find((k) => startStatus.data!.steps[k] === "todo") : undefined;
  const nothing = tab === "open" ? list.length === 0 : inbox.done.length === 0;
  return (
    <div data-today-page data-showing-detail={route.showingDetail || undefined} className="flex w-full min-w-0 flex-col gap-3 p-4 md:h-full md:min-h-0 md:p-6">
      <div data-today-reminders className="flex shrink-0 flex-col gap-3 empty:hidden [&:not(:has(>*))]:hidden">
        <DesktopConfigIssues />
      </div>
      {startLeft && !startDismissed ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3.5 rounded-[20px] bg-(--today-banner-bg) py-3.5 pr-4 pl-[18px] shadow-[var(--today-banner-ring)]">
          <img src={cosmicAssets.planetViolet} alt="" className="size-[34px] rounded-full shadow-[var(--today-banner-glow)]" />
          <span className="flex min-w-[220px] flex-1 flex-col">
            <span className="text-[14px]/5 font-semibold">{t("inbox.page.startLeft", { count: startLeft })}</span>
            {startNext ? <span className="text-xs/[18px] font-medium text-fg-secondary">{t(`start.${startNext}`)}</span> : null}
          </span>
          <Button variant="solid" size="sm" onClick={() => { window.location.hash = "/start"; }}>{t("inbox.page.startOpen")}</Button>
          <Button variant="ghost" size="sm" onClick={() => setStartDismissed(true)}>{t("inbox.page.startLater")}</Button>
        </div>
      ) : null}
      {/* Two panes on a desktop, each its own single scroll region: the page itself never scrolls behind them. */}
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
        <section
          data-today-list
          aria-label={t("inbox.listLabel")}
          className={cn("min-h-0 min-w-0 flex-col rounded-[24px] bg-(--surface-1) shadow-[var(--ring-glass)]", route.showingDetail ? "hidden" : "flex")}
        >
          <div className="flex shrink-0 items-center gap-1.5 px-3.5 pt-3.5 pb-2.5 shadow-[inset_0_-1px_0_var(--today-rule)]">
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
                  className="cosmic-tag min-h-11 cursor-pointer outline-none focus-visible:focus-ring md:min-h-0"
                >
                  {label} · {n}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <span data-today-shortcuts data-inbox-role={inbox.role} className="hidden text-[11px]/4 font-semibold text-(--text-faint) md:inline">{t("inbox.page.keys")}</span>
          </div>
          <div ref={listPane} data-today-scroll className="min-h-0 flex-1 overscroll-contain pb-2.5 md:overflow-y-auto">
            {nothing ? (
              inbox.loading ? null : (
                <div data-today-empty className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <CircleCheckBig aria-hidden="true" className="size-8 text-(--mark-ok)" />
                  <p className="m-0 text-[15px]/6 font-semibold text-fg-strong">{tab === "open" ? t("inbox.page.empty") : t("inbox.page.doneEmpty")}</p>
                  {tab === "open" ? <p className="m-0 max-w-[280px] text-[13px]/5 font-medium text-fg-muted">{t("inbox.page.emptyHint")}</p> : null}
                </div>
              )
            ) : (
              <div role="listbox" aria-label={t("inbox.listLabel")}>
                {tab === "open"
                  ? sections.map(({ section, items }) => {
                      const Icon = SECTION_ICON[section];
                      return (
                        <div key={section} role="group" aria-labelledby={`inbox-section-${section}`} data-inbox-section={section} className="flex flex-col">
                          {/* Sticky so the section of the row under the eye stays named while the list scrolls. */}
                          <div id={`inbox-section-${section}`} className="sticky top-0 z-[1] flex items-center gap-2 bg-(--surface-1) px-[18px] pt-3.5 pb-2 text-[11px]/4 font-semibold tracking-[0.6px] text-fg-muted uppercase">
                            <Icon aria-hidden="true" className={cn("size-3.5", section === "fix" ? "text-danger" : section === "decide" ? "text-fg-brand" : "text-fg-muted")} />
                            <span className="min-w-0 flex-1">{t(`inbox.page.section.${section}`)}</span>
                            <span className="rounded-full bg-(--glass-bg) px-2 py-0.5 text-[11px]/4 tracking-normal text-fg-strong tabular-nums">{items.length}</span>
                          </div>
                          {items.length ? items.map((item) => (
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
                              onPick={() => open(item.key)}
                            />
                          )) : (
                            <div className="px-[18px] pb-2 text-[13px]/5 font-medium text-fg-muted">{t(`inbox.page.sectionEmpty.${section}`)}</div>
                          )}
                        </div>
                      );
                    })
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
                        onPick={() => open(d.key)}
                      />
                    ))}
              </div>
            )}
          </div>
        </section>
        <section
          ref={detailPane}
          data-today-detail
          aria-label={current ? titleOf(current, t) : doneCurrent?.title ?? t("inbox.page.pickHint")}
          className={cn("min-h-0 min-w-0 flex-col gap-3 md:overflow-y-auto md:overscroll-contain", mobile && !route.showingDetail ? "hidden" : "flex")}
        >
          {route.showingDetail ? <MobileBack onClick={back} /> : null}
          <ErrorNote error={inbox.error ?? remoteSetup.error} />
          {current ? (
            <Detail key={current.key} item={current} now={now} onActions={setActions} finish={finish} seen={seen} />
          ) : doneCurrent ? (
            <DoneDetail entry={doneCurrent} now={now} onReopen={() => inbox.reopen(doneCurrent.key)} />
          ) : !mobile && !inbox.loading && !nothing ? (
            // An empty list says so itself; this pane only asks for a pick when there is something to pick.
            <div className="grid min-h-[240px] flex-1 place-items-center rounded-[24px] px-6 text-center text-[14px]/[22px] font-medium text-fg-muted shadow-[var(--ring-glass)]">
              {t("inbox.page.pickHint")}
            </div>
          ) : null}
        </section>
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
        "relative mx-2 grid min-h-11 cursor-pointer touch-manipulation grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] px-2.5 py-3 text-left outline-none focus-visible:focus-ring",
        on ? "bg-(--today-row-selected-bg) shadow-[var(--today-row-selected-ring)]" : "hover:bg-(--glass-bg) active:bg-(--glass-bg)",
      )}
    >
      {/* The selected row has a bar at its edge too, so it is told apart without its tint. */}
      {on ? <span aria-hidden="true" className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-(--accent-violet)" /> : null}
      <span className={cn("mt-1.5 size-2 rounded-full", DOT[dot])} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className={cn("text-[13.5px]/[19px] text-pretty text-fg-strong [overflow-wrap:anywhere]", on ? "font-bold" : "font-semibold")}>{title}</span>
        <span className="truncate text-xs/[18px] font-medium text-fg-muted">
          {scope}
          {meta ? ` · ${meta}` : ""}
        </span>
      </span>
      <span className="pt-0.5 text-[11px]/4 font-semibold text-(--text-faint) tabular-nums">{age}</span>
    </div>
  );
}

const VARIANT = { primary: "solid", secondary: "glass", ghost: "ghost", danger: "glass" } as const;
/** Buttons shown beside the main one; the rest go behind "Thao tác khác" so the bar never wraps into a wall. */
const VISIBLE_SECONDARY = 3;

/** The main action first: ↵ runs it, and it is the one drawn large. */
function ordered(actions: Action[]): Action[] {
  const main = actions.find((a) => a.kind === "primary") ?? actions[0];
  return main ? [main, ...actions.filter((a) => a !== main)] : [];
}

/** The detail card: pill and age, title, the item's blocks, then its actions in a bar that stays in sight. */
function DetailCard({ dot, kind, scope, when, title, children, actions, busy, foot }: { dot: TodayDot; kind: string; scope: string; when: string; title: string; children?: ReactNode; actions: Action[]; busy: boolean; foot?: string }) {
  const t = useT();
  const [main, ...rest] = ordered(actions);
  const shown = rest.slice(0, VISIBLE_SECONDARY);
  const overflow = rest.slice(VISIBLE_SECONDARY);
  return (
    <div className="flex min-w-0 flex-col gap-5 rounded-[24px] bg-(--surface-1) px-4 pt-5 shadow-[var(--ring-glass)] md:px-7 md:pt-6 [&>header+p]:-mt-2.5">
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
      {/* Sticky: a long diff or log must not push the decision out of sight. */}
      <div data-today-actions className="sticky bottom-0 z-[1] -mx-4 flex flex-wrap items-center gap-2.5 rounded-b-[24px] bg-(--surface-1) px-4 pt-3 pb-5 shadow-[0_-1px_0_var(--today-rule)] md:-mx-7 md:px-7 md:pb-6">
        {main ? (
          <Button variant={VARIANT[main.kind]} size="lg" disabled={busy} onClick={() => void main.run()} className="max-md:w-full">
            {main.label}
          </Button>
        ) : null}
        {shown.map((a) => (
          <Button key={a.label} variant={VARIANT[a.kind]} size="md" disabled={busy} onClick={() => void a.run()}>
            {a.label}
          </Button>
        ))}
        {overflow.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="md" disabled={busy} aria-label={t("inbox.page.moreActions")} title={t("inbox.page.moreActions")}>
                <Ellipsis aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {overflow.map((a) => (
                <DropdownMenuItem key={a.label} className="min-h-11" onSelect={() => void a.run()}>{a.label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
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
  finish: (item: InboxItem, note: string, undo?: Undo) => void;
  seen: (item: InboxItem) => void;
}) {
  const { client, bump, me } = useHive();
  const toast = useToast();
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
  // What closing a review task now would leave behind, read up front so Chuyển sang Xong can run without asking.
  const closeTask = item.kind === "review" && allow(item.task.project, "codeReview") ? item.task : null;
  const closeWarning = useQuery(async () => (closeTask ? taskCloseWarning(client, closeTask, t) : null), [client, closeTask?.project, closeTask?.id, closeTask?.updatedAt]);

  // Runs at once. A result with `undo` is an action the hub can take back: Hoàn tác calls it (see revert).
  const act = (fn: () => Promise<string | { note: string; undo: Undo } | null>): (() => Promise<void>) => async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result === null) return;
      bump();
      inbox.reload();
      if (typeof result === "string") finish(item, result);
      else finish(item, result.note, result.undo);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  // Hoàn tác for an action the hub has an inverse for: call it, and the item is back in the list.
  const revert = (inverse: () => Promise<unknown>): Undo => async () => {
    await inverse();
    inbox.reopen(item.key);
    bump();
    inbox.reload();
    toast(t("inbox.page.undone"));
  };
  // For an action the hub cannot take back: it goes out after the undo window, and Hoàn tác inside it cancels the send.
  const later = (note: string, send: () => Promise<unknown>) => () => {
    if (inFlight.current) return;
    const key = item.key;
    const cancel = holdSend(key, async () => {
      await send();
      bump();
      inbox.reload();
    }, (err) => {
      // The item comes back so the person sees it is not done, with what went wrong.
      inbox.reopen(key);
      toast(t("inbox.page.sendFailed", { error: errorMessage(err) }), { tone: "error" });
    });
    finish(item, note, () => {
      if (!cancel()) {
        toast(t("inbox.page.undoTooLate"));
        return;
      }
      inbox.reopen(key);
      toast(t("inbox.page.undone"));
    });
  };
  const open = (url: string | null | undefined) => () => {
    if (url) window.open(url, "_blank", "noopener");
  };
  const go = (hash: string) => () => {
    window.location.hash = hash;
  };
  const seenAction = (label = t("inbox.seen")): Action => ({ label, kind: "ghost", run: () => seen(item) });

  // Delayed send: the hub has no call that turns auto-fix back on for an MR, so Hoàn tác cancels before it goes out.
  const stopCi = (project: string, mrUrl: string | null): Action[] => mrUrl && allow(project, "runDispatch") ? [{
    label: t("inbox.ci.stop"), kind: "ghost", run: later(t("inbox.ci.stopped"), () => client.call("runs.stopCi", { project, mrUrl })),
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
          {closeWarning.data ? (
            <Note tone="warning">
              <span data-close-warning className="whitespace-pre-line">{`${t("inbox.page.closeCheck")}: ${closeWarning.data}`}</span>
            </Note>
          ) : null}
        </>
      );
      const canMove = allow(task.project, "codeReview");
      actions = [
        ...(canMove && hubRun?.mrUrl && (!hubRun.mr?.status || hubRun.mr.status === "opened") && !hubRun.mr?.draft && hubRun.mr?.pipeline !== "failed" && hubRun.merge?.status !== "pending" ? [{
          // Merge goes out at once, with no undo: a merged branch cannot be unmerged, and the person asked for it.
          label: t("inbox.review.merge"), kind: "primary" as const, run: act(async () => {
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
                // Real undo: the hub takes the status back. What closing leaves behind shows above, not in a dialog.
                run: act(async () => {
                  await client.call("tasks.update", { id: task.id, status: "done" });
                  return { note: t("inbox.review.movedDone", { id: task.id }), undo: revert(() => client.call("tasks.update", { id: task.id, status: task.status })) };
                }),
              },
            ]
          : []),
        { label: t("inbox.review.markReviewed"), kind: "ghost", run: () => finish(item, t("inbox.review.reviewed", { id: task.id }), () => inbox.reopen(item.key)) },
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
            // Delayed send for both: the hub cannot make a shared entry a project's again, nor bring a removed one back.
            ...(m.project !== null && allow(null, "memoryApprove") ? [{
              label: t("inbox.memory.share"), kind: "secondary" as const, run: later(t("inbox.memory.shared", { id: m.id }), () => client.call("memory.share", { id: m.id })),
            }] : []),
            { label: t("inbox.memory.reject"), kind: "ghost", run: later(t("inbox.memory.rejected", { id: m.id }), () => client.call("memory.remove", { id: m.id })) },
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
      // Delayed send: keeping one entry replaces the other for good, and the hub has no call that restores it.
      const resolve = (keep: "this" | "other" | "both", note: string) => later(note, () => client.call("memory.resolve", { id: a.id, other: b.id, keep }));
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
          // Real undo: the request waits for the machine's owner, and the hub cancels it while it is still pending.
          label: t("inbox.machine.installRemote"), kind: "primary" as const, run: act(async () => {
            const command = await client.call("admin.commandCreate", { machineId: item.machineId!, itemId: s.id });
            return { note: t("inbox.machine.installRequested", { machine: item.machine! }), undo: revert(() => client.call("admin.commandCancel", { id: command.id })) };
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
        item.machineId ? { label: t("inbox.proposal.reject"), kind: "ghost", run: () => finish(item, t("inbox.machine.installDeclined", { label: s.label }), () => inbox.reopen(item.key)) } : seenAction(t("inbox.machine.skip")),
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
    onActions(busy ? [] : ordered(actions));
    return () => onActions([]);
  });

  return (
    <DetailCard dot={todayDot(item)} kind={t(`inbox.tag.${item.kind}`)} scope={scopeText(item, t)} when={longAgo(item.at, now, t)} title={titleOf(item, t)} actions={actions} busy={busy} foot={t("inbox.page.foot")}>
      {body}
      <ErrorNote error={error} />
    </DetailCard>
  );
}
