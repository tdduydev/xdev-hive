// Talking with a project's leader agent (hub only, roadmap 17): threads by project, each held on one team machine
// whose Claude plan writes the replies in the same Claude Code session. A reply shows as the machine writes it,
// with the agent's steps; project managers send messages and stop a reply. The desktop app has it too (roadmap 48):
// on a hub the same threads, a new one on this machine by default; in local mode this machine's own, in its database.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookMarked, Bot, Check, CheckCheck, MessageSquarePlus, Pencil, RotateCcw, Search, SendHorizontal, Settings2, Square, Trash2, X } from "lucide-react";
import { cn } from "cn";
import { CHAT_EFFORTS, CHAT_MODEL_ALIASES, policySummary, type AgentPolicy, type ChatAction, type ChatEffort, type ChatMessage, type ChatThread } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, StatusDot } from "#ui/components/common.tsx";
import { AttachButton, AttachmentBar, MessageFiles, useAttachments } from "#ui/components/ChatFiles.tsx";
import { LeaderGuideSheet } from "#ui/components/LeaderGuide.tsx";
import { CopyButton, ReplyMarkdown } from "#ui/components/ReplyMarkdown.tsx";
import { errorMessage, formatTime, formatUsd, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";
import {
  ACTION_TONE,
  actionTask,
  chatMachines,
  chatProfile,
  chatTarget,
  isLiveReply,
  machineName,
  mergeMessages,
  pollAfter,
  REPLY_TONE,
  stepCount,
  withAction,
} from "#ui/lib/chat.ts";
import { requestErrorText, runLabel } from "#ui/lib/runs.ts";
import { scopeFilter, scopeId, scopeKey, scopeProject } from "#ui/lib/scope.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";

/** Machines report a reply being written every 2 s: followed that closely; otherwise a slow check for news. */
const LIVE_MS = 2000;
const IDLE_MS = 15_000;
/** chat.send takes up to 8000 characters. */
const MAX_TEXT = 8000;

type Open = { kind: "thread"; id: number } | { kind: "new" } | null;

const threadOf = (param: string | null): Open => param === "new" ? { kind: "new" } : (param && /^\d+$/.test(param) && Number(param) > 0 ? { kind: "thread", id: Number(param) } : null);

/** The desktop app on its own (roadmap 48): its chats are in its database and run on it alone. */
function useLocalChat(): boolean {
  const { client, me } = useHive();
  return !!client.desktop && me.mode !== "hub";
}

/** The machines a chat may run on: the hub's, or in local mode this machine as its database's chat sees it. */
function useChatMachines(deps: unknown[]) {
  const { client } = useHive();
  const local = useLocalChat();
  return useQuery(
    async () => (local ? [await client.desktop!.chatMachine!()].filter((m) => m !== null) : client.call("machines.list", {})),
    [client, local, ...deps],
  );
}

export function ChatPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const project = scopeProject(scope);
  const [busy, setBusy] = useState(false);
  const poll = usePoll(busy ? LIVE_MS : IDLE_MS);
  // Typed words are looked up once the typing pauses.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const threads = useQuery(
    () => client.call("chat.threads", { ...scopeFilter(scope), query: query || undefined, limit: 100 }),
    [client, scopeKey(scope), query, poll],
  );
  useEffect(() => setBusy((threads.data ?? []).some((th) => th.busy)), [threads.data]);
  // The open thread is in the address (#/chat?thread=12): a link to it opens it, and so does coming back to the page.
  const mobileDetail = useMobileDetail("thread");
  const [open, setOpenState] = useState<Open>(() => threadOf(mobileDetail.value));
  const setOpen = useCallback((next: Open) => {
    if (mobileDetail.mobile) mobileDetail.navigate(next?.kind === "thread" ? String(next.id) : next?.kind === "new" ? "new" : null);
    else window.history.replaceState(null, "", next?.kind === "thread" ? `#/chat?thread=${next.id}` : "#/chat");
    setOpenState(next);
  }, [mobileDetail]);
  useEffect(() => {
    setOpenState(threadOf(mobileDetail.value));
  }, [mobileDetail.value]);
  // Another project or system picked in the sidebar: its own threads.
  const shown = scopeId(scope);
  const shownBefore = useRef(shown);
  useEffect(() => {
    if (shownBefore.current !== shown) (shownBefore.current = shown), setOpen(null);
  }, [shown, setOpen]);
  // A system's chats are each with one of its projects' leaders.
  const managed = (project ? [project] : scope.kind === "system" ? scope.projects : projects).filter((p) => allow(p, "chatUse"));
  const [guideOpen, setGuideOpen] = useState(false);
  const local = useLocalChat();

  return (
    <Page wide className="mobile-master-detail">
      <PageHeader
        title={t("nav.chat")}
        subtitle={t(local ? "chat.subtitleLocal" : "chat.subtitle")}
        actions={
          managed.length ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
                <BookMarked />
                {t("chat.guideOpen")}
              </Button>
              <Button size="sm" data-chat-new onClick={() => setOpen({ kind: "new" })}>
              <MessageSquarePlus />
              {t("chat.new")}
            </Button>
            </>
          ) : null
        }
      />
      {managed.length ? <LeaderGuideSheet key={shown} projects={managed} defaultProject={project} open={guideOpen} onOpenChange={setGuideOpen} /> : null}
      <ErrorNote error={threads.error} />
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        {/* On a phone the list and the open chat take turns. */}
        <nav className={cn("flex min-w-0 flex-col gap-2", open && "hidden lg:flex")} aria-label={t("chat.threads")}>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input className="pl-8" type="search" placeholder={t("chat.search")} aria-label={t("chat.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {threads.data?.length === 0 ? <Empty>{query ? t("chat.noMatch", { query }) : t("chat.none")}</Empty> : null}
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
            <Conversation
              key={open.id}
              threadId={open.id}
              onBack={() => setOpen(null)}
              onChanged={threads.reload}
              onDeleted={() => (setOpen(null), threads.reload())}
            />
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
  const local = useLocalChat();
  const [bumped, setBumped] = useState(0);
  const machines = useChatMachines([bumped]);
  const fit = chatMachines(machines.data ?? [], project);
  // The desktop app: this machine's name, and whether it takes runs from the hub (its leader only runs if so).
  const desk = useQuery(async () => (client.desktop ? client.desktop.settings() : null), [client, bumped]);
  const here = desk.data?.machine ?? null;
  const hubOff = !local && desk.data?.mode === "hub" && !desk.data.runner.acceptHubRuns;
  const [machineId, setMachineId] = useState("");
  const machine = fit.find((m) => m.id === machineId) ?? fit[0] ?? null;
  const [profileId, setProfileId] = useState("");
  // Until the person picks a machine or plan, the form follows what loads (the project's defaults, the machines).
  const [touched, setTouched] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ChatEffort | "">("");
  const [text, setText] = useState("");
  const action = useAction();
  const saving = useAction();
  const enabling = useAction();
  const [saved, setSaved] = useState(false);
  const att = useAttachments(project);
  // What the project set for its chats fills the form; the person may pick otherwise.
  const defaults = useQuery(() => client.call("chat.defaults", { project }), [client, project]);
  useEffect(() => {
    const d = defaults.data;
    if (!d) return;
    setModel(d.model ?? "");
    setEffort(d.effort ?? "");
    setSaved(false);
  }, [defaults.data]);
  const fitKey = fit.map((m) => `${m.id}:${m.profiles.filter(chatProfile).map((p) => p.id).join(",")}`).join(" ");
  useEffect(() => {
    if (touched || !defaults.data) return;
    const target = chatTarget(fit, { here, defaults: defaults.data, now: new Date().toISOString() });
    setMachineId(target.machineId);
    setProfileId(target.profileId);
    // fit is read through fitKey: a new array each render, the same machines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, defaults.data, fitKey, here]);
  const pick = (next: { machineId?: string; profileId: string }) => {
    setTouched(true);
    if (next.machineId !== undefined) setMachineId(next.machineId);
    setProfileId(next.profileId);
  };
  const enableHubRuns = () =>
    void enabling.run(async () => {
      await client.desktop!.updateSettings({ runner: { acceptHubRuns: true } });
      // The hub hears it with a heartbeat: one now, so this machine is offered at once.
      await client.desktop!.hubRetry().catch(() => undefined);
      setTouched(false);
      setBumped((n) => n + 1);
    });
  const send = () => {
    if (!machine || !text.trim() || action.busy || att.uploading) return;
    void action.run(async () => {
      const sent = await client.call("chat.send", {
        project,
        machineId: machine.id,
        profileId: profileId || null,
        model: model || null,
        effort: effort || null,
        text,
        files: att.ids,
      });
      att.clear();
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
          <p className="text-xs text-muted-foreground">{t(local ? "chat.newHintLocal" : "chat.newHint")}</p>
        </div>
      </div>
      <form
        className="flex flex-col gap-3"
        onDragOver={(e) => att.enabled && e.preventDefault()}
        onDrop={att.onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-project">{t("chat.project")}</Label>
            <NativeSelect id="chat-project" size="sm" className="w-full" value={project} onChange={(e) => (setProject(e.target.value), setTouched(false))}>
              {projects.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-machine">{t("chat.machine")}</Label>
            <NativeSelect id="chat-machine" size="sm" className="w-full" value={machine?.id ?? ""} disabled={!machine || local} onChange={(e) => pick({ machineId: e.target.value, profileId: "" })}>
              {fit.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.machine}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-plan">{t("chat.plan")}</Label>
            <NativeSelect id="chat-plan" size="sm" className="w-full" value={profileId} disabled={!machine} onChange={(e) => pick({ profileId: e.target.value })}>
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
        <div className="grid gap-3 sm:grid-cols-3">
          <ModelFields model={model} effort={effort} onModel={(v) => (setModel(v), setSaved(false))} onEffort={(v) => (setEffort(v), setSaved(false))} idPrefix="chat-new" />
          <div className="flex items-end">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={saving.busy}
              title={t("chat.saveDefaultsHint", { project })}
              onClick={() =>
                void saving.run(async () => {
                  await client.call("chat.setDefaults", {
                    project,
                    machineId: machine?.id ?? null,
                    profileId: profileId || null,
                    model: model || null,
                    effort: effort || null,
                  });
                  setSaved(true);
                })
              }
            >
              {t("chat.saveDefaults")}
            </Button>
          </div>
        </div>
        {saved ? <Notice tone="ok">{t("chat.defaultsSaved", { project })}</Notice> : null}
        <ErrorNote error={saving.error} />
        <ErrorNote error={machines.error} />
        {hubOff && here ? (
          <Notice tone="warn">
            <div className="flex flex-col gap-2" data-chat-here="off">
              <span>{t("chat.hereOff", { machine: here })}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Button size="sm" type="button" disabled={enabling.busy} onClick={enableHubRuns}>
                  {t("chat.hereEnable")}
                </Button>
                <a className={LINK} href="#/agents">
                  {t("chat.hereAgents")}
                </a>
              </span>
            </div>
          </Notice>
        ) : null}
        <ErrorNote error={enabling.error} />
        {!local && !hubOff && here && machines.data && fit.length > 0 && !fit.some((m) => m.machine === here) ? (
          <Notice tone="info">{t("chat.hereNotFit", { machine: here, project })}</Notice>
        ) : null}
        {machines.data && !fit.length ? <Notice tone="info">{t(local ? "chat.noMachineLocal" : "chat.noMachine", { project })}</Notice> : null}
        <Textarea
          rows={4}
          maxLength={MAX_TEXT}
          placeholder={t("chat.placeholder")}
          aria-label={t("chat.message")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter starts a new line; not while an input method is still composing a word.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), send();
          }}
        />
        <AttachmentBar att={att} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AttachButton att={att} />
            {t("chat.sendHint")}
          </span>
          <Button size="sm" type="submit" disabled={!machine || !text.trim() || action.busy || att.uploading}>
            <SendHorizontal />
            {t("chat.start")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </Card>
  );
}

function Conversation({ threadId, onBack, onChanged, onDeleted }: { threadId: number; onBack: () => void; onChanged: () => void; onDeleted: () => void }) {
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
  const machines = useChatMachines([live ? 0 : tick]);
  const machine = thread ? machines.data?.find((m) => m.id === thread.machineId) : undefined;
  const manage = thread ? allow(thread.project, "chatUse") : false;
  // What the leader proposes to do is approved apart from chatting (roadmap 25).
  const approve = thread ? allow(thread.project, "chatApprove") : false;
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
    <Card className="flex h-[calc(100svh-9rem)] min-h-[28rem] flex-col gap-0 py-0 lg:h-[calc(100svh-13rem)]" data-chat-thread={threadId}>
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={onBack} aria-label={t("chat.threads")}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          {thread && manage ? (
            <ThreadTitle thread={thread} onRenamed={(th) => (setThread(th), onChanged())} onDeleted={onDeleted} />
          ) : (
            <h2 className="font-medium wrap-anywhere">{thread?.title ?? "…"}</h2>
          )}
          {thread ? (
            <p className="text-xs text-muted-foreground wrap-anywhere">
              <span className="font-mono">{thread.project}</span> · <span className="font-mono">{thread.machine}</span> · {thread.profileId ?? t("chat.anyPlan")} ·{" "}
              {thread.model ?? t("chat.modelDefault")}
              {thread.effort ? ` (${t(`effort.${thread.effort}`)})` : ""} ·{" "}
              {t("chat.startedBy", { who: thread.createdBy, time: formatTime(thread.createdAt) })}
            </p>
          ) : null}
        </div>
        {thread && manage ? <ThreadSettings thread={thread} onChanged={(th) => (setThread(th), onChanged())} /> : null}
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
                approve={approve}
                onStopped={refresh}
                onDecided={(a) => setMessages((ms) => withAction(ms, a))}
                onDecidedAll={(replyId, actions) => setMessages((ms) => ms.map((x) => (x.id === replyId ? { ...x, actions } : x)))}
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

/** A model picker (Claude Code's aliases, or the one already set) and an effort picker; empty is the plan's own. */
function ModelFields({
  model,
  effort,
  onModel,
  onEffort,
  idPrefix,
}: {
  model: string;
  effort: ChatEffort | "";
  onModel: (model: string) => void;
  onEffort: (effort: ChatEffort | "") => void;
  idPrefix: string;
}) {
  const t = useT();
  const models: string[] = [...CHAT_MODEL_ALIASES, ...(model && !(CHAT_MODEL_ALIASES as readonly string[]).includes(model) ? [model] : [])];
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-model`}>{t("chat.model")}</Label>
        <NativeSelect id={`${idPrefix}-model`} size="sm" className="w-full" value={model} onChange={(e) => onModel(e.target.value)}>
          <NativeSelectOption value="">{t("chat.modelDefault")}</NativeSelectOption>
          {models.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {m}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-effort`}>{t("chat.effort")}</Label>
        <NativeSelect id={`${idPrefix}-effort`} size="sm" className="w-full" value={effort} onChange={(e) => onEffort(e.target.value as ChatEffort | "")}>
          <NativeSelectOption value="">{t("chat.effortDefault")}</NativeSelectOption>
          {CHAT_EFFORTS.map((e) => (
            <NativeSelectOption key={e} value={e}>
              {t(`effort.${e}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </>
  );
}

/** A thread's model and effort for its next replies, changed by a manager. */
function ThreadSettings({ thread, onChanged }: { thread: ChatThread; onChanged: (thread: ChatThread) => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(thread.model ?? "");
  const [effort, setEffort] = useState<ChatEffort | "">(thread.effort ?? "");
  if (!open) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("chat.settings")}
        title={t("chat.settings")}
        onClick={() => (setModel(thread.model ?? ""), setEffort(thread.effort ?? ""), setOpen(true))}
      >
        <Settings2 />
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-2 rounded-md border bg-muted/30 p-2 sm:w-80"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          onChanged(await client.call("chat.configure", { threadId: thread.id, model: model || null, effort: effort || null }));
          setOpen(false);
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <ModelFields model={model} effort={effort} onModel={setModel} onEffort={setEffort} idPrefix={`chat-${thread.id}`} />
      </div>
      <p className="text-xs text-muted-foreground">{t("chat.settingsHint")}</p>
      <div className="flex gap-1">
        <Button size="sm" type="submit" disabled={action.busy}>
          {t("chat.save")}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}

/** A manager's thread title: renamed in place, or the thread deleted (not while a reply is pending). */
function ThreadTitle({ thread, onRenamed, onDeleted }: { thread: ChatThread; onRenamed: (thread: ChatThread) => void; onDeleted: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);
  if (editing) {
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            onRenamed(await client.call("chat.rename", { threadId: thread.id, title }));
            setEditing(false);
          });
        }}
      >
        <div className="flex flex-wrap items-center gap-1">
          <Input className="h-8 min-w-0 flex-1" maxLength={120} autoFocus onFocus={(e) => e.currentTarget.select()} aria-label={t("chat.rename")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button size="sm" type="submit" disabled={!title.trim() || action.busy}>
            {t("chat.save")}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => (setEditing(false), setTitle(thread.title))}>
            {t("common.cancel")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1">
        <h2 className="min-w-0 flex-1 font-medium wrap-anywhere">{thread.title}</h2>
        <Button size="icon-sm" variant="ghost" aria-label={t("chat.rename")} title={t("chat.rename")} onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-destructive"
          aria-label={t("chat.delete")}
          title={thread.busy ? t("chat.deleteBusy") : t("chat.delete")}
          disabled={thread.busy || action.busy}
          onClick={() => {
            if (!window.confirm(t("chat.confirmDelete", { title: thread.title }))) return;
            void action.run(async () => (await client.call("chat.delete", { threadId: thread.id }), onDeleted()));
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </div>
  );
}

function UserMessage({ message: m }: { message: ChatMessage }) {
  return (
    <li className="flex flex-col items-end gap-1">
      <MessageFiles files={m.files} />
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
  approve,
  onStopped,
  onDecided,
  onDecidedAll,
  onResend,
}: {
  message: ChatMessage;
  machine: string;
  taskIds: string[];
  manage: boolean;
  /** May accept or refuse the leader's actions. */
  approve: boolean;
  onStopped: () => void;
  onDecided: (action: ChatAction) => void;
  onDecidedAll: (replyId: number, actions: ChatAction[]) => void;
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
        {m.actions.length ? <ActionList reply={m} taskIds={taskIds} manage={approve} onDecided={onDecided} onDecidedAll={onDecidedAll} /> : null}
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

/** What the leader asked to do in one reply; with several waiting, a manager decides them all at once. */
function ActionList({
  reply,
  taskIds,
  manage,
  onDecided,
  onDecidedAll,
}: {
  reply: ChatMessage;
  taskIds: string[];
  manage: boolean;
  onDecided: (action: ChatAction) => void;
  onDecidedAll: (replyId: number, actions: ChatAction[]) => void;
}) {
  const { client } = useHive();
  const t = useT();
  const act = useAction();
  const [stopped, setStopped] = useState(false);
  const waiting = reply.actions.filter((a) => a.status === "proposed").length;
  const decideAll = (accept: boolean) =>
    void act.run(async () => {
      const actions = await client.call("chat.decideAll", { replyId: reply.id, accept });
      // The hub stopped at one that failed: the rest still wait.
      setStopped(accept && actions.some((a) => a.status === "proposed"));
      onDecidedAll(reply.id, actions);
    });
  return (
    <section className="flex flex-col gap-2" aria-label={t("chat.actions")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t("chat.actions")}</h3>
        {manage && waiting >= 2 ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" className="h-7" disabled={act.busy} title={t("chat.confirmAllHint")} onClick={() => decideAll(true)}>
              <CheckCheck />
              {t("chat.confirmAll", { count: waiting })}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={act.busy} onClick={() => decideAll(false)}>
              <X />
              {t("chat.dismissAll")}
            </Button>
          </div>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {reply.actions.map((a) => (
          <ActionItem key={a.id} action={a} taskIds={taskIds} manage={manage} onDecided={onDecided} />
        ))}
      </ul>
      {stopped && waiting ? <Notice tone="warn">{t("chat.stoppedAll")}</Notice> : null}
      <ErrorNote error={act.error} />
    </section>
  );
}

/** One thing the leader asked to do: what, why, and for a project manager Confirm (runs with their rights) or Set aside. */
/** One action a leader proposed: what it does, why, and (for a manager, while proposed) confirm or set aside. */
export function ActionItem({ action: a, taskIds, manage, onDecided }: { action: ChatAction; taskIds: string[]; manage: boolean; onDecided: (action: ChatAction) => void }) {
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
  // A task for another service of the system (roadmap 19d): which one, first.
  if (a.kind === "task.create" && input.project && input.project !== a.project) detail.push(t("chat.actionService", { project: String(input.project) }));
  if (a.kind === "task.create" && Array.isArray(input.dependsOn) && input.dependsOn.length) detail.push(t("chat.actionDeps", { ids: input.dependsOn.join(", ") }));
  if (a.kind === "run.dispatch") {
    detail.push(input.profileId ? t("chat.actionPlan", { plan: String(input.profileId) }) : t("board.rotate"));
    if (Number(input.candidates) > 1) detail.push(t("board.candidatesMany", { n: Number(input.candidates) }));
    if (input.reviewAfter) detail.push(t("board.reviewAfter"));
  }
  const text = a.kind === "task.update" ? input.note : a.kind === "run.dispatch" ? input.instructions : null;
  const taskLink = task ? (
    <a className={cn(LINK, "font-mono text-[0.9em]")} href={`#/tasks?task=${encodeURIComponent(task)}`}>
      {task}
    </a>
  ) : null;
  const run = String(input.runId ?? "");
  const runLink = (
    <a className={cn(LINK, "font-mono text-[0.9em]")} href={`#/runs?run=${encodeURIComponent(run)}`}>
      {run}
    </a>
  );
  const machine = <span className="font-mono">{machineName(String(input.machineId ?? ""))}</span>;
  const change = [
    input.enabled === true ? t("chat.actionProfileOn") : input.enabled === false ? t("chat.actionProfileOff") : null,
    typeof input.priority === "number" ? t("chat.actionProfilePriority", { n: input.priority }) : null,
  ].filter(Boolean);
  // The project's part as it was when proposed, and as it would be: null is the hub's default alone.
  const policyText = (p: unknown) => (p && typeof p === "object" ? policySummary(p as Partial<AgentPolicy>) : t("chat.actionPolicyNone"));
  // A project's tool setting (roadmap 28e): on, off or the tool's default, and whether its machines must have it.
  const toolText = (s: unknown) => {
    const { enabled, required } = (s ?? {}) as { enabled?: boolean | null; required?: boolean };
    const state = enabled === true ? t("chat.actionToolOn") : enabled === false ? t("chat.actionToolOff") : t("chat.actionToolDefault");
    return required ? `${state}, ${t("chat.actionToolRequired")}` : state;
  };
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5 text-xs" data-action-status={a.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={ACTION_TONE[a.status] ?? "neutral"}>{t(`actionStatus.${a.status}`)}</Badge>
        {/* Roadmap 29c: the project lets its leader run this kind alone, as whoever sent the message. */}
        {a.auto ? <Badge tone="info">{t("chat.autoRan", { who: a.decidedBy ?? "?" })}</Badge> : null}
        <span className="min-w-0 text-sm wrap-anywhere">
          {a.kind === "task.create" ? (
            <>
              {t("chat.actionCreate")} {a.status === "done" || (task && taskIds.includes(task)) ? taskLink : <span className="font-mono text-[0.9em]">{task}</span>}: {String(input.title ?? "")}
            </>
          ) : a.kind === "task.update" ? (
            <>
              {t("chat.actionMove")} {taskLink} → {t(`taskStatus.${String(input.status)}` as never)}
            </>
          ) : a.kind === "run.dispatch" ? (
            <>
              {t("chat.actionRun", { role: runLabel("agentRole", String(input.role ?? "implement")) })} {taskLink} · {machine}
            </>
          ) : a.kind === "run.cancel" ? (
            rich(t("chat.actionCancel"), { run: runLink, machine })
          ) : a.kind === "run.merge" ? (
            <>
              {rich(t("chat.actionMerge"), { run: runLink })}
              <MergeLink machineId={String(input.machineId ?? "")} runId={run} />
            </>
          ) : a.kind === "machine.profile" ? (
            rich(t("chat.actionProfile", { profile: String(input.profileId ?? ""), change: change.join(", ") }), { machine })
          ) : a.kind === "agent.policy" ? (
            t("chat.actionPolicy")
          ) : a.kind === "agents.stop" ? (
            t("chat.actionStop")
          ) : a.kind === "agents.resume" ? (
            t("chat.actionResume")
          ) : a.kind === "tool.enable" ? (
            t("chat.actionTool", { tool: String(input.name ?? input.id ?? ""), change: toolText(a.input) })
          ) : (
            rich(t("chat.actionInstall", { item: String(input.itemId ?? "") }), { machine })
          )}
        </span>
      </div>
      {detail.length ? <div className="text-muted-foreground">{detail.join(" · ")}</div> : null}
      {a.kind === "agent.policy" ? (
        <div className="flex flex-col gap-0.5 rounded-md bg-background/60 p-2 wrap-anywhere">
          <span>{t("chat.actionPolicyBefore", { policy: policyText(a.input.before) })}</span>
          <span>{t("chat.actionPolicyAfter", { policy: policyText(a.input.policy) })}</span>
        </div>
      ) : null}
      {a.kind === "tool.enable" && a.input.before ? <div className="text-muted-foreground">{t("chat.actionToolBefore", { state: toolText(a.input.before) })}</div> : null}
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
          {a.result?.requestId && task ? (
            <>
              {" · "}
              <a className={LINK} href={`#/tasks?task=${encodeURIComponent(task)}`}>
                {t("chat.actionRequest", { id: a.result.requestId })}
              </a>
            </>
          ) : null}
          {a.result?.commandId ? (
            <>
              {" · "}
              {t("chat.actionCommand", { id: a.result.commandId })}
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

/** The MR/PR of a run to merge, when the hub knows it and the reader may see the run. */
function MergeLink({ machineId, runId }: { machineId: string; runId: string }) {
  const { client } = useHive();
  const t = useT();
  const run = useQuery(() => client.call("runs.get", { machineId, runId }), [client, machineId, runId]);
  const url = run.data?.mrUrl;
  return url ? (
    <>
      {" · "}
      <a className={LINK} href={url} target="_blank" rel="noreferrer">
        {t("chat.actionMrLink")}
      </a>
    </>
  ) : null;
}

function Composer({ thread, onSent }: { thread: ChatThread; onSent: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [text, setText] = useState("");
  const action = useAction();
  const att = useAttachments(thread.project);
  const send = () => {
    if (!text.trim() || thread.busy || action.busy || att.uploading) return;
    void action.run(async () => {
      await client.call("chat.send", { project: thread.project, threadId: thread.id, text, files: att.ids });
      setText("");
      att.clear();
      onSent();
    });
  };
  return (
    <form
      className="flex flex-col gap-2"
      onDragOver={(e) => att.enabled && e.preventDefault()}
      onDrop={att.onDrop}
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
        onPaste={att.onPaste}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter starts a new line; not while an input method is still composing a word.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) e.preventDefault(), send();
        }}
      />
      <AttachmentBar att={att} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <AttachButton att={att} />
          {thread.busy ? t("chat.busy") : t("chat.sendHint")}
        </span>
        <Button size="sm" type="submit" disabled={!text.trim() || thread.busy || action.busy || att.uploading}>
          <SendHorizontal />
          {t("chat.send")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}
