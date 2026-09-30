// Hôm nay (docs/design/2026-09-redesign, xDev Hive Client): a list of what needs the person on the left, the
// selected item with its actions on the right. J / K move, ↵ runs the first button, E marks it seen.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, Copy, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type { Memory } from "@xdev-hive/core";
import { Diff } from "../components/Diff.tsx";
import { ErrorNote } from "../components/common.tsx";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "../hooks.ts";
import { useT, type TFunction } from "../i18n/index.tsx";
import { shortAgo, type InboxDone, type InboxItem, type InboxTone } from "../lib/inbox.ts";
import { docOwner } from "../lib/scope.ts";
import { useInbox } from "../shell/inbox.tsx";
import { useToast } from "../shell/toast.tsx";

type Kind = InboxTone | "success" | "neutral";

const CHIP: Record<Kind, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  neutral: "bg-neutral-soft text-neutral",
};

function Chip({ kind, children }: { kind: Kind; children: ReactNode }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-xs px-[7px] text-[11px]/none font-semibold whitespace-nowrap", CHIP[kind])}>{children}</span>;
}

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

function Kv({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]/5">
      {rows.map(([k, v, mono]) => (
        <div key={k} className="contents">
          <span className="text-fg-muted">{k}</span>
          <span className={cn("text-fg-strong", mono && "font-mono text-xs/5")}>{v}</span>
        </div>
      ))}
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

// ── What each kind shows and can do ──

interface Action {
  label: string;
  kind: "primary" | "secondary" | "ghost" | "danger";
  run: () => void | Promise<void>;
}

const BTN: Record<Action["kind"], string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "border border-action-secondary-line bg-action-secondary text-action-secondary-fg hover:bg-action-secondary-hover",
  ghost: "text-fg-secondary hover:bg-hover hover:text-fg-strong",
  danger: "border border-danger-line text-danger hover:bg-danger-soft",
};

const firstLine = (s: string, max = 90) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function titleOf(item: InboxItem, t: TFunction): string {
  switch (item.kind) {
    case "ci": {
      const mr = item.run.mrIid ? t("inbox.ci.mr", { iid: item.run.mrIid }) : "MR";
      const jobs = item.run.ciFix?.jobs.map((j) => j.name).join(", ");
      return jobs ? t("inbox.ci.title", { mr, jobs }) : t("inbox.ci.titleNoJobs", { mr });
    }
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
  }
}

function metaOf(item: InboxItem, t: TFunction): string {
  switch (item.kind) {
    case "ci": {
      const f = item.run.ciFix;
      if (!f) return t("inbox.ci.noFix");
      const live = item.run.status === "running" || item.run.status === "queued";
      return live ? t("inbox.ci.fixing", { profile: item.run.profileId ?? "agent", n: f.n, max: f.max }) : t("inbox.ci.fixed", { n: f.n, max: f.max });
    }
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
  }
}

/** "8 ph trước", or "vừa xong" alone; "" when the time is unknown. */
function longAgo(iso: string, now: number, t: TFunction): string {
  const when = shortAgo(iso, now, t);
  return !when || when === t("inbox.ago.now") ? when : t("inbox.agoLong", { when });
}

function scopeText(item: InboxItem, t: TFunction): string {
  return item.scope || t("inbox.shared");
}

export function TodayPage() {
  const inbox = useInbox();
  const t = useT();
  const [tab, setTab] = useState<"open" | "done">("open");
  const [sel, setSel] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const list = tab === "open" ? inbox.items : [];
  const current = tab === "open" ? (list.find((i) => i.key === sel) ?? list[0] ?? null) : null;
  const doneCurrent = tab === "done" ? (inbox.done.find((d) => d.key === sel) ?? inbox.done[0] ?? null) : null;

  useEffect(() => {
    if (current) inbox.markRead(current.key);
  }, [current, inbox]);

  // The action buttons of the item on screen, so ↵ can run the first one.
  const [actions, setActions] = useState<Action[]>([]);
  const keys = useMemo(() => (tab === "open" ? list.map((i) => i.key) : inbox.done.map((d) => d.key)), [tab, list, inbox.done]);
  const selKey = current?.key ?? doneCurrent?.key ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
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
      } else if (e.key === "Enter" && actions[0]) {
        e.preventDefault();
        void actions[0].run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toast = useToast();
  const next = (key: string) => {
    const i = keys.indexOf(key);
    setSel(keys[i + 1] ?? keys[i - 1] ?? null);
  };
  const finish = (item: InboxItem, note: string, undoable = false) => {
    next(item.key);
    inbox.markDone({ key: item.key, kind: item.kind, tone: item.tone, title: titleOf(item, t), scope: scopeText(item, t), note });
    toast(note, undoable ? { undo: () => inbox.reopen(item.key) } : undefined);
  };
  const seen = (item: InboxItem) => finish(item, t("inbox.seenNote"), true);

  return (
    <div className="flex h-full min-h-0 bg-surface">
      <div className="flex min-w-[280px] shrink basis-[360px] flex-col border-r border-line-subtle">
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
                  setSel(null);
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
        </div>
        <div role="listbox" aria-label={t("inbox.listLabel")} className="min-h-0 flex-1 overflow-y-auto">
          {tab === "open"
            ? list.map((item) => {
                const on = item.key === current?.key;
                const unread = !inbox.read.has(item.key) && !on;
                return (
                  <div
                    key={item.key}
                    role="option"
                    aria-selected={on}
                    onClick={() => setSel(item.key)}
                    className={cn(
                      "relative flex cursor-pointer flex-col gap-1 border-b border-line-subtle py-2.5 pr-3.5 pl-[22px]",
                      on ? "bg-selected" : "hover:bg-hover",
                    )}
                  >
                    {unread ? <span aria-label={t("inbox.unread")} className="absolute top-[17px] left-[9px] size-[7px] rounded-full bg-info-solid" /> : null}
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Chip kind={item.tone}>{t(`inbox.tag.${item.kind}`)}</Chip>
                      <span className="min-w-0 flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong">{titleOf(item, t)}</span>
                      <span className="shrink-0 text-[11px]/none text-fg-muted">{shortAgo(item.at, now, t)}</span>
                    </div>
                    <span className="truncate text-xs/4 text-fg-muted">
                      <span className="font-mono">{scopeText(item, t)}</span>
                      {metaOf(item, t) ? ` · ${metaOf(item, t)}` : ""}
                    </span>
                  </div>
                );
              })
            : inbox.done.map((d) => (
                <div
                  key={d.key}
                  role="option"
                  aria-selected={d.key === doneCurrent?.key}
                  onClick={() => setSel(d.key)}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 border-b border-line-subtle py-2.5 pr-3.5 pl-[22px]",
                    d.key === doneCurrent?.key ? "bg-selected" : "hover:bg-hover",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Chip kind={d.tone}>{t(`inbox.tag.${d.kind}`)}</Chip>
                    <span className="min-w-0 flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong">{d.title}</span>
                    <span className="shrink-0 text-[11px]/none text-fg-muted">{shortAgo(d.at, now, t)}</span>
                  </div>
                  <span className="truncate text-xs/4 text-fg-muted">
                    <span className="font-mono">{d.scope}</span> · {d.note}
                  </span>
                </div>
              ))}
          {(tab === "open" ? list.length : inbox.done.length) === 0 && !inbox.loading ? (
            <div className="px-6 py-10 text-center text-[13px] text-fg-muted">{t("inbox.empty")}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-3.5 border-t border-line-subtle px-3.5 py-[7px] text-[11px]/4 text-fg-muted">
          <span>{t("inbox.keySelect")}</span>
          <span>{t("inbox.keyMain")}</span>
          <span>{t("inbox.keySeen")}</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
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

function Header({ chips, scope, when, title }: { chips: ReactNode; scope: string; when: string; title: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line-subtle px-6 pt-4 pb-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips}
        <span className="font-mono text-xs/none font-medium text-fg-muted">{scope}</span>
        <span className="text-xs/none text-fg-muted">{when}</span>
      </div>
      <h2 className="m-0 font-display text-lg/[26px] font-semibold text-pretty text-fg-strong">{title}</h2>
    </div>
  );
}

function Footer({ actions, foot, busy }: { actions: Action[]; foot: string; busy: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-subtle bg-subtle px-6 py-[11px]">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          onClick={() => void a.run()}
          className={cn(
            "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-sm px-3 text-xs/none font-semibold whitespace-nowrap outline-none focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-60",
            BTN[a.kind],
          )}
        >
          {a.label}
        </button>
      ))}
      <span className="ml-auto min-w-0 text-xs/4 text-fg-muted">{foot}</span>
    </div>
  );
}

function DoneDetail({ entry, now, onReopen }: { entry: InboxDone; now: number; onReopen: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header chips={<Chip kind={entry.tone}>{t(`inbox.tag.${entry.kind}`)}</Chip>} scope={entry.scope} when={longAgo(entry.at, now, t)} title={entry.title} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[760px] flex-col gap-3 px-6 pt-[18px] pb-6">
          <P>{t("inbox.doneNote", { note: entry.note })}</P>
        </div>
      </div>
      <Footer actions={[{ label: t("inbox.reopen"), kind: "secondary", run: onReopen }]} foot={t("inbox.doneNote", { note: entry.note })} busy={false} />
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
  const docKey = item.kind === "proposal" ? item.proposal.docKey : null;
  const doc = useQuery(async () => (docKey ? client.call("docs.get", { key: docKey }) : null), [client, docKey]);

  const act = (fn: () => Promise<string>): (() => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      const note = await fn();
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
    case "proposal": {
      const p = item.proposal;
      const manage = allow(docOwner(p.docKey), "manage");
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
            { label: t("inbox.proposal.openDoc"), kind: "secondary", run: go(`#/docs?doc=${encodeURIComponent(p.docKey)}`) },
            {
              label: t("inbox.proposal.reject"),
              kind: "ghost",
              run: act(async () => {
                await client.call("proposals.reject", { id: p.id });
                return t("inbox.proposal.rejected", { doc: p.docKey });
              }),
            },
          ]
        : [{ label: t("inbox.proposal.openDoc"), kind: "secondary", run: go(`#/docs?doc=${encodeURIComponent(p.docKey)}`) }, seenAction()];
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
          <P>{task.note?.trim() || t("inbox.review.noNote")}</P>
        </>
      );
      const canMove = allow(task.project, "contribute");
      actions = [
        ...(r?.mrUrl ? [{ label: t("inbox.review.openMr"), kind: "primary" as const, run: open(r.mrUrl) }] : []),
        { label: t("inbox.review.openTask"), kind: r?.mrUrl ? "secondary" : "primary", run: go(`#/tasks?task=${encodeURIComponent(task.id)}`) },
        ...(canMove
          ? [
              {
                label: t("inbox.review.toDone"),
                kind: "secondary" as const,
                run: act(async () => {
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
          <Kv
            rows={[
              [t("inbox.memory.kind"), t(`memoryKind.${m.kind}`)],
              [t("inbox.memory.scope"), m.project ?? t("inbox.shared"), true],
              [t("inbox.memory.author"), m.author, true],
              ...(m.taskId ? ([[t("inbox.memory.task"), m.taskId, true]] as Array<[string, string, boolean]>) : []),
            ]}
          />
        </>
      );
      actions = allow(m.project, "manage")
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
      actions = allow(a.project, "manage")
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
    case "request": {
      const c = item.command;
      body = (
        <>
          <P>{t("inbox.request.body", { label: c.label })}</P>
          <Kv rows={[[c.itemId, formatTime(c.requestedAt), true]]} />
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
    onActions(actions);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header chips={<Chip kind={item.tone}>{t(`inbox.tag.${item.kind}`)}</Chip>} scope={scopeText(item, t)} when={longAgo(item.at, now, t)} title={titleOf(item, t)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-[760px] flex-col gap-3 px-6 pt-[18px] pb-6">
          {body}
          <ErrorNote error={error} />
        </div>
      </div>
      <Footer actions={actions} foot={t("inbox.enterHint")} busy={busy} />
    </div>
  );
}
