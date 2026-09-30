// Talking with a project's leader agent (hub only, roadmap 17): threads by project, each held on one team machine
// whose Claude plan writes the replies in the same Claude Code session. A reply shows as the machine writes it,
// with the agent's steps; project managers send messages and stop a reply.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, MessageSquarePlus, RotateCcw, SendHorizontal, Square, X } from "lucide-react";
import { cn } from "cn";
import type { ChatAction, ChatMessage, ChatThread } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card } from "@xdev-hive/ui/components/ui/card";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, StatusDot } from "../components/common.tsx";
import { CopyButton, ReplyMarkdown } from "../components/ReplyMarkdown.tsx";
import { errorMessage, formatTime, formatUsd, useAction, useCan, useHashParam, useHive, usePoll, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import {
  ACTION_TONE,
  actionTask,
  chatMachines,
  chatProfile,
  isLiveReply,
  machineName,
  mergeMessages,
  pollAfter,
  REPLY_TONE,
  stepCount,
  withAction,
} from "../lib/chat.ts";
import { requestErrorText, runLabel } from "../lib/runs.ts";
import { scopeProject } from "../lib/scope.ts";

/** Machines report a reply being written every 2 s: followed that closely; otherwise a slow check for news. */
const LIVE_MS = 2000;
const IDLE_MS = 15_000;
/** chat.send takes up to 8000 characters. */
const MAX_TEXT = 8000;

type Open = { kind: "thread"; id: number } | { kind: "new" } | null;

const threadOf = (param: string | null): Open => (param && /^\d+$/.test(param) && Number(param) > 0 ? { kind: "thread", id: Number(param) } : null);

export function ChatPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const project = scopeProject(scope);
  const [busy, setBusy] = useState(false);
  const poll = usePoll(busy ? LIVE_MS : IDLE_MS);
  const threads = useQuery(() => client.call("chat.threads", { project: project ?? undefined, limit: 100 }), [client, project, poll]);
  useEffect(() => setBusy((threads.data ?? []).some((th) => th.busy)), [threads.data]);
  // The open thread is in the address (#/chat?thread=12): a link to it opens it, and so does coming back to the page.
  const [linked] = useHashParam("thread");
  const [open, setOpenState] = useState<Open>(() => threadOf(linked));
  const setOpen = useCallback((next: Open) => {
    window.history.replaceState(null, "", next?.kind === "thread" ? `#/chat?thread=${next.id}` : "#/chat");
    setOpenState(next);
  }, []);
  useEffect(() => {
    const next = threadOf(linked);
    if (next) setOpenState(next);
  }, [linked]);
  // Another project picked in the sidebar: its own threads.
  const shownProject = useRef(project);
  useEffect(() => {
    if (shownProject.current !== project) (shownProject.current = project), setOpen(null);
  }, [project, setOpen]);
  const managed = (project ? [project] : projects).filter((p) => allow(p, "manage"));

  return (
    <Page wide>
      <PageHeader
        title={t("nav.chat")}
        subtitle={t("chat.subtitle")}
        actions={
          managed.length ? (
            <Button size="sm" onClick={() => setOpen({ kind: "new" })}>
              <MessageSquarePlus />
              {t("chat.new")}
            </Button>
          ) : null
        }
      />
      <ErrorNote error={threads.error} />
      <div className="grid items-start gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        {/* On a phone the list and the open chat take turns. */}
        <nav className={cn("flex min-w-0 flex-col gap-2", open && "hidden lg:flex")} aria-label={t("chat.threads")}>
          {threads.data?.length === 0 ? <Empty>{t("chat.none")}</Empty> : null}
          <ul className="flex flex-col gap-1.5">
            {(threads.data ?? []).map((th) => (
              <ThreadItem key={th.id} thread={th} showProject={project === null} selected={open?.kind === "thread" && open.id === th.id} onOpen={() => setOpen({ kind: "thread", id: th.id })} />
            ))}
          </ul>
        </nav>
        <div className={cn("min-w-0", !open && "hidden lg:block")}>
          {open?.kind === "new" ? (
            <NewThread
              projects={managed}
              defaultProject={project}
              onBack={() => setOpen(null)}
              onStarted={(id) => (setOpen({ kind: "thread", id }), threads.reload())}
            />
          ) : open ? (
            <Conversation key={open.id} threadId={open.id} onBack={() => setOpen(null)} onChanged={threads.reload} />
          ) : (
            <Empty>{managed.length ? t("chat.pick") : t("chat.pickReadOnly")}</Empty>
          )}
        </div>
      </div>
    </Page>
  );
}

function ThreadItem({ thread: th, showProject, selected, onOpen }: { thread: ChatThread; showProject: boolean; selected: boolean; onOpen: () => void }) {
  const t = useT();
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          selected && "border-brand/40 bg-brand-soft/60 hover:bg-brand-soft/60",
        )}
        onClick={onOpen}
      >
        <span className="flex w-full items-start gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium wrap-anywhere">{th.title}</span>
          {th.busy ? (
            <span className="mt-1.5" title={t("chat.answering")}>
              <StatusDot tone="info" className="animate-pulse" />
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {showProject ? <span className="font-mono">{th.project}</span> : null}
          <span className="font-mono">{th.machine}</span>
          <span>{formatTime(th.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

function NewThread({ projects, defaultProject, onBack, onStarted }: { projects: string[]; defaultProject: string | null; onBack: () => void; onStarted: (id: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const [project, setProject] = useState(defaultProject && projects.includes(defaultProject) ? defaultProject : (projects[0] ?? ""));
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const fit = chatMachines(machines.data ?? [], project);
  const [machineId, setMachineId] = useState("");
  const machine = fit.find((m) => m.id === machineId) ?? fit[0] ?? null;
  const [profileId, setProfileId] = useState("");
  const [text, setText] = useState("");
  const action = useAction();
  const send = () => {
    if (!machine || !text.trim() || action.busy) return;
    void action.run(async () => {
      const sent = await client.call("chat.send", { project, machineId: machine.id, profileId: profileId || null, text });
      onStarted(sent.thread.id);
    });
  };

  return (
    <Card className="gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={onBack} aria-label={t("chat.threads")}>
          <ArrowLeft />
        </Button>
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium">{t("chat.new")}</h2>
          <p className="text-xs text-muted-foreground">{t("chat.newHint")}</p>
        </div>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-project">{t("chat.project")}</Label>
            <NativeSelect id="chat-project" size="sm" className="w-full" value={project} onChange={(e) => (setProject(e.target.value), setMachineId(""), setProfileId(""))}>
              {projects.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-machine">{t("chat.machine")}</Label>
            <NativeSelect id="chat-machine" size="sm" className="w-full" value={machine?.id ?? ""} disabled={!machine} onChange={(e) => (setMachineId(e.target.value), setProfileId(""))}>
              {fit.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.machine}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-plan">{t("chat.plan")}</Label>
            <NativeSelect id="chat-plan" size="sm" className="w-full" value={profileId} disabled={!machine} onChange={(e) => setProfileId(e.target.value)}>
              <NativeSelectOption value="">{t("chat.anyPlan")}</NativeSelectOption>
              {(machine?.profiles ?? []).filter(chatProfile).map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.label}
                  {p.overLimit ? ` (${t("board.profileOverLimit")})` : p.cooldownUntil && p.cooldownUntil > new Date().toISOString() ? ` (${t("board.resting")})` : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        <ErrorNote error={machines.error} />
        {machines.data && !fit.length ? <Notice tone="info">{t("chat.noMachine", { project })}</Notice> : null}
        <Textarea
          rows={4}
          maxLength={MAX_TEXT}
          placeholder={t("chat.placeholder")}
          aria-label={t("chat.message")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter starts a new line; not while an input method is still composing a word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), send();
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("chat.sendHint")}</span>
          <Button size="sm" type="submit" disabled={!machine || !text.trim() || action.busy}>
            <SendHorizontal />
            {t("chat.start")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </Card>
  );
}

function Conversation({ threadId, onBack, onChanged }: { threadId: number; onBack: () => void; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [bump, setBump] = useState(0);
  const live = messages.some(isLiveReply);
  const tick = usePoll(live ? LIVE_MS : IDLE_MS);
  const known = useRef(messages);
  known.current = messages;
  // Only what changed since the last poll: a reply being written, and anything newer.
  useEffect(() => {
    let alive = true;
    client.call("chat.get", { threadId, after: pollAfter(known.current) }).then(
      (res) => {
        if (!alive) return;
        if (!res) return setGone(true);
        setThread(res.thread);
        setMessages((m) => mergeMessages(m, res.messages));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [client, threadId, tick, bump]);
  // A reply that ended, or an action confirmed, may have made tasks: their ids become links.
  const ended = messages.filter((m) => m.status === "done").length + messages.flatMap((m) => m.actions).filter((a) => a.status === "done").length;
  const tasks = useQuery(async () => (thread ? client.call("tasks.list", { project: thread.project }) : []), [client, thread?.project, ended]);
  const taskIds = (tasks.data ?? []).map((task) => task.id);
  const machines = useQuery(() => client.call("machines.list", {}), [client, live ? 0 : tick]);
  const machine = thread ? machines.data?.find((m) => m.id === thread.machineId) : undefined;
  const manage = thread ? allow(thread.project, "manage") : false;
  const refresh = () => (setBump((n) => n + 1), onChanged());

  // Follows the reply as it grows, unless the reader scrolled up to read something else.
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = messages.at(-1);
  // A last reply that did not come through can be asked again, with the message it answered.
  const retry =
    thread && manage && !thread.busy && last?.role === "assistant" && ["failed", "expired", "cancelled"].includes(last.status ?? "")
      ? messages.findLast((m) => m.role === "user" && m.id < last.id)
      : undefined;
  const resend = retry && thread ? async () => (await client.call("chat.send", { project: thread.project, threadId: thread.id, text: retry.text }), refresh()) : undefined;
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text, last?.steps, last?.status]);

  if (gone) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="warn">{t("chat.gone")}</Notice>
        <div>
          <Button size="sm" variant="outline" onClick={onBack}>
            {t("chat.threads")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card className="flex h-[calc(100svh-9rem)] min-h-[28rem] flex-col gap-0 py-0 lg:h-[calc(100svh-13rem)]">
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={onBack} aria-label={t("chat.threads")}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium wrap-anywhere">{thread?.title ?? "…"}</h2>
          {thread ? (
            <p className="text-xs text-muted-foreground wrap-anywhere">
              <span className="font-mono">{thread.project}</span> · <span className="font-mono">{thread.machine}</span> · {thread.profileId ?? t("chat.anyPlan")} ·{" "}
              {t("chat.startedBy", { who: thread.createdBy, time: formatTime(thread.createdAt) })}
            </p>
          ) : null}
        </div>
      </header>
      <div
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <ErrorNote error={error} />
        <ol className="flex flex-col gap-4" aria-live="polite">
          {messages.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <Reply
                key={m.id}
                message={m}
                machine={thread?.machine ?? ""}
                taskIds={taskIds}
                manage={manage}
                onStopped={refresh}
                onDecided={(a) => setMessages((ms) => withAction(ms, a))}
                onResend={m.id === last?.id ? resend : undefined}
              />
            ),
          )}
        </ol>
      </div>
      <footer className="flex flex-col gap-2 border-t px-4 py-3">
        {thread && machines.data && (!machine?.online || !machine.acceptsRuns) ? <Notice tone="warn">{t("chat.machineGone", { machine: thread.machine })}</Notice> : null}
        {thread && manage ? <Composer thread={thread} onSent={refresh} /> : thread ? <p className="text-xs text-muted-foreground">{t("chat.readOnly")}</p> : null}
      </footer>
    </Card>
  );
}

function UserMessage({ message: m }: { message: ChatMessage }) {
  return (
    <li className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-soft px-3 py-2 text-sm whitespace-pre-wrap text-brand-soft-foreground wrap-anywhere">{m.text}</div>
      <span className="text-xs text-muted-foreground">
        {m.author} · {formatTime(m.createdAt)}
      </span>
    </li>
  );
}

function Reply({
  message: m,
  machine,
  taskIds,
  manage,
  onStopped,
  onDecided,
  onResend,
}: {
  message: ChatMessage;
  machine: string;
  taskIds: string[];
  manage: boolean;
  onStopped: () => void;
  onDecided: (action: ChatAction) => void;
  /** Sends the message this reply answered again (the last reply, when it did not come through). */
  onResend?: () => Promise<unknown>;
}) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const live = isLiveReply(m);
  const steps = stepCount(m.steps);
  return (
    <li className="flex flex-col items-start gap-1">
      <div className="flex w-full max-w-[92%] flex-col gap-2 rounded-2xl rounded-bl-sm border bg-card px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden />
          <span className="font-mono">{m.author}</span>
          {m.status ? <Badge tone={REPLY_TONE[m.status] ?? "neutral"}>{t(`replyStatus.${m.status}`)}</Badge> : null}
          {m.costUsd !== null ? <span>{t("board.cost", { cost: formatUsd(m.costUsd) })}</span> : null}
          {m.text && !live ? <CopyButton text={m.text} label={t("chat.copy")} className="ml-auto" /> : null}
        </div>
        {m.text ? <ReplyMarkdown text={m.text} taskIds={taskIds} /> : live ? <p className="text-muted-foreground">{m.status === "pending" ? t("chat.waitingMachine", { machine }) : t("chat.writing")}</p> : null}
        {live && m.activity ? (
          <div className="flex items-center gap-2 text-xs text-info">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-info" aria-hidden />
            <span className="wrap-anywhere">{m.activity}</span>
          </div>
        ) : null}
        {m.steps ? (
          <details className="text-xs" open={live}>
            <summary className="cursor-pointer text-muted-foreground select-none">{t("chat.steps", { count: steps })}</summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 font-mono whitespace-pre-wrap wrap-anywhere">{m.steps}</pre>
          </details>
        ) : null}
        {m.actions.length ? (
          <section className="flex flex-col gap-2" aria-label={t("chat.actions")}>
            <h3 className="text-xs font-medium text-muted-foreground">{t("chat.actions")}</h3>
            <ul className="flex flex-col gap-2">
              {m.actions.map((a) => (
                <ActionItem key={a.id} action={a} taskIds={taskIds} manage={manage} onDecided={onDecided} />
              ))}
            </ul>
          </section>
        ) : null}
        {m.error ? <div className="text-xs text-destructive wrap-anywhere">{requestErrorText(m.error)}</div> : null}
        {onResend ? (
          <div>
            <Button size="sm" variant="outline" className="h-7" disabled={action.busy} onClick={() => void action.run(onResend)}>
              <RotateCcw />
              {t("chat.resend")}
            </Button>
          </div>
        ) : null}
        {live && manage ? (
          <div>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await client.call("chat.cancel", { replyId: m.id });
                  onStopped();
                })
              }
            >
              <Square />
              {t("chat.stop")}
            </Button>
          </div>
        ) : null}
        <ErrorNote error={action.error} />
      </div>
      <span className="text-xs text-muted-foreground">{formatTime(m.finishedAt ?? m.createdAt)}</span>
    </li>
  );
}

/** One thing the leader asked to do: what, why, and for a project manager Confirm (runs with their rights) or Set aside. */
function ActionItem({ action: a, taskIds, manage, onDecided }: { action: ChatAction; taskIds: string[]; manage: boolean; onDecided: (action: ChatAction) => void }) {
  const { client } = useHive();
  const t = useT();
  const act = useAction();
  const task = actionTask(a);
  const input = a.input as Record<string, string | number | boolean | string[] | null | undefined>;
  const decide = (accept: boolean) =>
    void act.run(async () => {
      onDecided(await client.call("chat.decide", { actionId: a.id, accept }));
    });
  const detail: string[] = [];
  if (a.kind === "task.create" && Array.isArray(input.dependsOn) && input.dependsOn.length) detail.push(t("chat.actionDeps", { ids: input.dependsOn.join(", ") }));
  if (a.kind === "run.dispatch") {
    detail.push(input.profileId ? t("chat.actionPlan", { plan: String(input.profileId) }) : t("board.rotate"));
    if (Number(input.candidates) > 1) detail.push(t("board.candidatesMany", { n: Number(input.candidates) }));
    if (input.reviewAfter) detail.push(t("board.reviewAfter"));
  }
  const text = a.kind === "task.update" ? input.note : a.kind === "run.dispatch" ? input.instructions : null;
  const taskLink = (
    <a className={cn(LINK, "font-mono text-[0.9em]")} href={`#/tasks?task=${encodeURIComponent(task)}`}>
      {task}
    </a>
  );
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={ACTION_TONE[a.status] ?? "neutral"}>{t(`actionStatus.${a.status}`)}</Badge>
        <span className="min-w-0 text-sm wrap-anywhere">
          {a.kind === "task.create" ? (
            <>
              {t("chat.actionCreate")} {a.status === "done" || taskIds.includes(task) ? taskLink : <span className="font-mono text-[0.9em]">{task}</span>}: {String(input.title ?? "")}
            </>
          ) : a.kind === "task.update" ? (
            <>
              {t("chat.actionMove")} {taskLink} → {t(`taskStatus.${String(input.status)}` as never)}
            </>
          ) : (
            <>
              {t("chat.actionRun", { role: runLabel("agentRole", String(input.role ?? "implement")) })} {taskLink} · <span className="font-mono">{machineName(String(input.machineId ?? ""))}</span>
            </>
          )}
        </span>
      </div>
      {detail.length ? <div className="text-muted-foreground">{detail.join(" · ")}</div> : null}
      {text ? <div className="rounded-md bg-background/60 p-2 whitespace-pre-wrap wrap-anywhere">{String(text)}</div> : null}
      <div className="text-muted-foreground wrap-anywhere">{t("chat.actionReason", { reason: a.reason })}</div>
      {a.status === "proposed" && manage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-7" disabled={act.busy} onClick={() => decide(true)}>
            <Check />
            {t("chat.confirm")}
          </Button>
          <Button size="sm" variant="ghost" className="h-7" disabled={act.busy} onClick={() => decide(false)}>
            <X />
            {t("chat.dismiss")}
          </Button>
          <span className="text-muted-foreground">{t("chat.confirmHint")}</span>
        </div>
      ) : null}
      {a.decidedBy && a.status !== "proposed" ? (
        <div className="text-muted-foreground">
          {t(a.status === "dismissed" ? "chat.actionDismissedBy" : "chat.actionConfirmedBy", { who: a.decidedBy, time: formatTime(a.decidedAt) })}
          {a.result?.requestId ? (
            <>
              {" · "}
              <a className={LINK} href={`#/tasks?task=${encodeURIComponent(task)}`}>
                {t("chat.actionRequest", { id: a.result.requestId })}
              </a>
            </>
          ) : null}
        </div>
      ) : null}
      {a.error ? <div className="text-destructive wrap-anywhere">{requestErrorText(a.error)}</div> : null}
      <ErrorNote error={act.error} />
    </li>
  );
}

const LINK = "font-medium text-primary underline underline-offset-2";

function Composer({ thread, onSent }: { thread: ChatThread; onSent: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [text, setText] = useState("");
  const action = useAction();
  const send = () => {
    if (!text.trim() || thread.busy || action.busy) return;
    void action.run(async () => {
      await client.call("chat.send", { project: thread.project, threadId: thread.id, text });
      setText("");
      onSent();
    });
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <Textarea
        rows={2}
        maxLength={MAX_TEXT}
        className="max-h-48"
        placeholder={t("chat.placeholder")}
        aria-label={t("chat.message")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter starts a new line; not while an input method is still composing a word.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), send();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{thread.busy ? t("chat.busy") : t("chat.sendHint")}</span>
        <Button size="sm" type="submit" disabled={!text.trim() || thread.busy || action.busy}>
          <SendHorizontal />
          {t("chat.send")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}
