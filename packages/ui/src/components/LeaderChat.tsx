// Talking with a project's leader agent (hub only, roadmap 17): threads by project, each held on one team machine
// whose selected Claude or Codex plan writes the replies in the same CLI session. A reply shows as the machine writes it,
// with the agent's steps; project managers send messages and stop a reply. The desktop app has it too (roadmap 48):
// on a hub the same threads, a new one on this machine by default; in local mode this machine's own, in its database.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, BookMarked, Bot, Check, CheckCheck, MessageSquarePlus, Pencil, RotateCcw, Search, SendHorizontal, Settings2, Square, Trash2, X } from "lucide-react";
import { cn } from "cn";
import { CHAT_EFFORTS, CHAT_MODEL_ALIASES, DEFAULT_MODEL_TIERS, HUB_SCOPE, policySummary, type AgentPolicy, type ChatAction, type ChatPlan, type ChatEffort, type ChatMessage, type ChatThread, type ResearchInput } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { TerminalEntry } from "#ui/components/RemoteTerminal.tsx";
import { Card } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, PageHeader, StatusDot } from "#ui/components/common.tsx";
import { ArtifactPreview } from "#ui/components/Artifacts.tsx";
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
  sendResearchPlan,
  isLiveReply,
  machineName,
  mergeMessages,
  pollAfter,
  REPLY_TONE,
  withAction,
} from "#ui/lib/chat.ts";
import { CHAT_SHORTCUTS, chatStatusCounts, isStatusCommand, matchingShortcuts, shortcutDraft, shortcutArgument, fillShortcutArgument, shortcutRuns, type ChatShortcut } from "#ui/lib/chat-shortcuts.ts";
import { quotaRows, quotaTotals } from "#ui/lib/quota.ts";
import { requestErrorText, runLabel } from "#ui/lib/runs.ts";
import { canEditChatSettings, canUseHubChat } from "#ui/lib/permission-controls.ts";
import { scopeFilter, scopeId, scopeKey, scopeProject } from "#ui/lib/scope.ts";
import { useChatDraft, useChatSession, type ChatOpen, type ChatPageContext } from "#ui/components/ChatSession.tsx";
import { AgentSteps } from "#ui/components/chat/AgentSteps.tsx";
import { ThreadSearch } from "#ui/components/chat/ThreadSearch.tsx";
import { ChatSessionBar } from "#ui/components/chat/ChatSessionBar.tsx";
import { chatSubmitKey, turnSeconds } from "#ui/lib/chat-presentation.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";

/** Machines report a reply being written every 2 s: followed that closely; otherwise a slow check for news. */
const LIVE_MS = 2000;
const IDLE_MS = 15_000;
/** chat.send takes up to 8000 characters. */
const MAX_TEXT = 8000;

const contextPrefix = (context: ChatPageContext | null) => context ? `[${context.id}](${context.href})${context.project ? ` · service: ${context.project}` : ""}\n\n` : "";
const withContext = (text: string, context: ChatPageContext | null) => contextPrefix(context) + text;

type Open = ChatOpen;

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

export function LeaderChat({ panel = false, context = null }: { panel?: boolean; context?: ChatPageContext | null }) {
  const { client, scope, projects, me } = useHive();
  const t = useT();
  const allow = useCan();
  const project = scopeProject(scope);
  const [busy, setBusy] = useState(false);
  const poll = usePoll(busy ? LIVE_MS : IDLE_MS);
  // Typed words are looked up once the typing pauses.
  const [search, setSearch] = useChatDraft(`threadListSearch:${scopeId(scope)}`, "");
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
  const newWork = useMobileDetail("newWork").value;
  const session = useChatSession();
  const shown = scopeId(scope);
  const routeScope = useRef(shown);
  const managedServices = (project ? [project] : scope.kind === "system" ? scope.projects : projects).filter((p) => allow(p, "chatUse"));
  const managed = canUseHubChat(me) ? [HUB_SCOPE, ...managedServices] : managedServices;
  const open: Open = session.selections[shown] !== undefined ? session.selections[shown] : (panel && managed.length ? { kind: "new" } : shown === routeScope.current && !panel ? threadOf(mobileDetail.value) : null);
  const setOpenState = useCallback((next: Open) => session.select(shown, next), [session.select, shown]);
  const setOpen = useCallback((next: Open) => {
    if (!panel && mobileDetail.mobile) mobileDetail.navigate(next?.kind === "thread" ? String(next.id) : next?.kind === "new" ? "new" : null);
    else if (!panel || window.location.hash.split("?")[0] === "#/chat") window.history.replaceState(null, "", next?.kind === "thread" ? `#/chat?thread=${next.id}` : next?.kind === "new" ? "#/chat?thread=new" : "#/chat");
    setOpenState(next);
  }, [mobileDetail, panel, setOpenState]);
  const routeBefore = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (panel || window.location.hash.split("?")[0] !== "#/chat" || routeBefore.current === mobileDetail.value) return;
    if (mobileDetail.value || routeBefore.current !== undefined) setOpenState(threadOf(mobileDetail.value));
    routeBefore.current = mobileDetail.value;
  }, [mobileDetail.value, panel, setOpenState]);
  // A fresh question must replace an already open draft, including when Chat stays mounted.
  useEffect(() => {
    if (!panel && window.location.hash.split("?")[0] === "#/chat" && newWork && session.drafts.values.get(`newKey:${shown}`) !== newWork) {
      session.drafts.values.set(`newKey:${shown}`, newWork);
      setOpenState({ kind: "new" });
    }
  }, [newWork, shown, panel, setOpenState, session.drafts]);
  // The source page may also have a newWork query; only Chat starts a new draft from it.
  const draftKey = `new:${shown}:${(!panel && newWork ? newWork : session.drafts.values.get(`newKey:${shown}`)) ?? "draft"}`;
  useEffect(() => {
    if (routeScope.current === shown) return;
    routeScope.current = shown;
    if (!panel && window.location.hash.split("?")[0] === "#/chat") setOpen(open);
  }, [shown, panel, open, setOpen]);
  const [guideOpen, setGuideOpen] = useState(false);
  const local = useLocalChat();
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.activeElement !== document.body && !surface.current?.contains(document.activeElement)) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "n" && managed.length) {
        event.preventDefault();
        setOpen({ kind: "new" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managed.length, setOpen]);

  return (
    <div ref={surface} data-leader-chat className={cn(panel ? "flex min-h-0 flex-1 flex-col gap-3 p-4" : "mobile-master-detail mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3 p-4 md:px-6 md:py-4", "max-md:[&_summary]:min-h-11 max-md:[&_a]:min-h-11 max-md:[&_a]:inline-flex max-md:[&_input]:text-base max-md:[&_select]:text-base max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 max-md:[&_input]:min-h-11 max-md:[&_select]:min-h-11 max-md:[&_textarea]:text-base")}>
      <PageHeader
        title={t("nav.chat")}
        subtitle={panel ? undefined : t("chat.workspaceHint")}
        actions={
          managed.length ? (
            <>
              <TerminalEntry source="chat" project={project ?? undefined} />
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
      <div className={cn("grid min-h-0 min-w-0 gap-4", panel ? "flex-1 grid-rows-[minmax(0,1fr)]" : "flex-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]")}>
        {/* On a phone the list and the open chat take turns. */}
        <nav className={cn("flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto", open && (panel ? "hidden" : "hidden lg:flex"))} aria-label={t("chat.threads")}>
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
        <div className={cn("flex min-h-0 min-w-0 flex-col overflow-y-auto", !open && (panel ? "hidden" : "hidden lg:block"))}>
          {open?.kind === "new" ? (
            <NewThread
              key={draftKey}
              draftKey={draftKey}
              context={context}
              panel={panel}
              projects={managed}
              defaultProject={project}
              onBack={() => setOpen(null)}
              onStarted={(id) => (setOpen({ kind: "thread", id }), threads.reload())}
            />
          ) : open ? (
            <Conversation
              key={open.id}
              panel={panel}
              context={context}
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
    </div>
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
              <StatusDot tone="info" className="animate-pulse motion-reduce:animate-none" /><span className="sr-only">{t("chat.answering")}</span>
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {showProject ? <span className="font-mono">{th.project === HUB_SCOPE ? t("chat.hubScope") : th.project}</span> : null}
          <span className="font-mono">{th.machine}</span>
          <span>{formatTime(th.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

function NewThread({ projects, defaultProject, onBack, onStarted, draftKey, context, panel }: { projects: string[]; defaultProject: string | null; onBack: () => void; onStarted: (id: number) => void; draftKey: string; context: ChatPageContext | null; panel: boolean }) {
  const { client, me } = useHive();
  const t = useT();
  const [setupOpen, setSetupOpen] = useChatDraft(`${draftKey}:setup`, false);
  const [chosenProject, setProject] = useChatDraft(`${draftKey}:project`, defaultProject && projects.includes(defaultProject) ? defaultProject : (projects[0] ?? ""));
  const project = projects.includes(chosenProject) ? chosenProject : defaultProject && projects.includes(defaultProject) ? defaultProject : (projects[0] ?? "");
  const local = useLocalChat();
  const projectLabel = project === HUB_SCOPE ? t("chat.hubScope") : project;
  const [bumped, setBumped] = useState(0);
  const machines = useChatMachines([bumped]);
  const fit = chatMachines(machines.data ?? [], project);
  // The desktop app: this machine's name, and whether it takes runs from the hub (its leader only runs if so).
  const desk = useQuery(async () => (client.desktop ? client.desktop.settings() : null), [client, bumped]);
  const here = desk.data?.machine ?? null;
  const hubOff = !local && desk.data?.mode === "hub" && !desk.data.runner.acceptHubRuns;
  const [machineId, setMachineId] = useChatDraft(`${draftKey}:machineId`, "");
  const machine = fit.find((m) => m.id === machineId) ?? fit[0] ?? null;
  const [profileId, setProfileId] = useChatDraft(`${draftKey}:profileId`, "");
  // Until the person picks a machine or plan, the form follows what loads (the project's defaults, the machines).
  const [touched, setTouched] = useChatDraft(`${draftKey}:touched`, false);
  const [model, setModel] = useChatDraft(`${draftKey}:model`, "");
  const [effort, setEffort] = useChatDraft<ChatEffort | "">(`${draftKey}:effort`, "");
  const [text, setText] = useChatDraft(`${draftKey}:text`, () => sessionStorage.getItem("hive-new-work-question") ?? "");
  useEffect(() => { sessionStorage.removeItem("hive-new-work-question"); }, []);
  const action = useAction();
  const saving = useAction();
  const enabling = useAction();
  const [saved, setSaved] = useState(false);
  const [defaultsFor, setDefaultsFor] = useChatDraft(`${draftKey}:defaultsFor`, "");
  const att = useAttachments(project, `${draftKey}:files:${project}`);
  // What the project set for its chats fills the form; the person may pick otherwise.
  const defaults = useQuery(() => client.call("chat.defaults", { project }), [client, project]);
  useEffect(() => {
    const d = defaults.data;
    if (!d || defaultsFor === project) return;
    setDefaultsFor(project);
    setModel(d.model ?? "");
    setEffort(d.effort ?? "");
    setSaved(false);
  }, [defaults.data, defaultsFor, project, setDefaultsFor, setModel, setEffort]);
  const fitKey = fit.map((m) => `${m.id}:${m.profiles.filter(chatProfile).map((p) => p.id).join(",")}`).join(" ");
  useEffect(() => {
    if (touched || !defaults.data) return;
    const target = chatTarget(fit, { here, defaults: defaults.data, now: new Date().toISOString() });
    setMachineId(target.machineId);
    setProfileId(target.profileId);
    const previous = fit.find((m) => m.id === defaults.data?.machineId)?.profiles.find((p) => p.id === defaults.data?.profileId);
    const selected = fit.find((m) => m.id === target.machineId)?.profiles.find((p) => p.id === target.profileId);
    if (previous && selected && previous.kind !== selected.kind) { setModel(""); setEffort(""); }
    // fit is read through fitKey: a new array each render, the same machines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touched, defaults.data, fitKey, here]);
  const pick = (next: { machineId?: string; profileId: string }) => {
    const before = machine?.profiles.find((p) => p.id === profileId)?.kind;
    const after = (fit.find((m) => m.id === (next.machineId ?? machine?.id))?.profiles ?? []).find((p) => p.id === next.profileId)?.kind;
    if (before !== after) { setModel(""); setEffort(""); }
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
    if (!machine || !text.trim() || withContext(text, context).length > MAX_TEXT || action.busy || (att.uploading || att.failed)) return;
    void action.run(async () => {
      const sent = await client.call("chat.send", {
        project,
        machineId: machine.id,
        profileId: profileId || null,
        model: model || null,
        effort: effort || null,
        text: withContext(text, context),
        files: att.ids,
      });
      setText("");
      att.clear();
      onStarted(sent.thread.id);
    });
  };

  return (
    <Card className="gap-4 p-4">
      <div className="flex items-center gap-2">
        <Button size="icon-sm" variant="ghost" className={panel ? undefined : "lg:hidden"} onClick={onBack} aria-label={t("chat.threads")}>
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
        <details data-chat-setup open={setupOpen} onToggle={(e) => setSetupOpen(e.currentTarget.open)} className="rounded-md border p-3">
          <summary className="min-h-11 cursor-pointer text-xs wrap-anywhere md:min-h-0">{t("chat.setup")} · {projectLabel} · {machine?.machine ?? t("chat.usageUnknown")} · {profileId || t("chat.anyPlan")}</summary>
          <div className="flex flex-col gap-3 pt-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="chat-project">{t(projects.includes(HUB_SCOPE) ? "chat.scope" : "chat.project")}</Label>
                <NativeSelect id="chat-project" size="sm" className="w-full min-h-11 data-[size=sm]:text-base md:min-h-0 md:data-[size=sm]:text-sm" value={project} onChange={(e) => (setProject(e.target.value), setTouched(false))}>
                  {projects.map((p) => (
                    <NativeSelectOption key={p} value={p}>
                      {p === HUB_SCOPE ? t("chat.hubScope") : p}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="chat-machine">{t("chat.machine")}</Label>
                <NativeSelect id="chat-machine" size="sm" className="w-full min-h-11 data-[size=sm]:text-base md:min-h-0 md:data-[size=sm]:text-sm" value={machine?.id ?? ""} disabled={!machine || local} onChange={(e) => pick({ machineId: e.target.value, profileId: "" })}>
                  {fit.map((m) => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {m.machine}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="chat-plan">{t("chat.plan")}</Label>
                <NativeSelect id="chat-plan" size="sm" className="w-full min-h-11 data-[size=sm]:text-base md:min-h-0 md:data-[size=sm]:text-sm" value={profileId} disabled={!machine} onChange={(e) => pick({ profileId: e.target.value })}>
                  <NativeSelectOption value="">{t("chat.anyPlan")}</NativeSelectOption>
                  {(machine?.profiles ?? []).filter(chatProfile).map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.label} · {p.kind === "codex" ? "Codex" : "Claude"}
                      {p.overLimit ? ` (${t("board.profileOverLimit")})` : p.cooldownUntil && p.cooldownUntil > new Date().toISOString() ? ` (${t("board.resting")})` : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {project === HUB_SCOPE ? <Notice tone="info">{t("chat.hubHint")}</Notice> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <ModelFields model={model} effort={effort} onModel={(v) => (setModel(v), setSaved(false))} onEffort={(v) => (setEffort(v), setSaved(false))} idPrefix="chat-new" kind={machine?.profiles.find((p) => p.id === profileId)?.kind} supportedModels={machine?.profiles.find((p) => p.id === profileId)?.supportedModels} />
              {canEditChatSettings(me, project) ? (
                <div className="flex items-end">
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={saving.busy}
                    title={t("chat.saveDefaultsHint", { project: projectLabel })}
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
              ) : null}
            </div>
            {saved ? <Notice tone="ok">{t("chat.defaultsSaved", { project: projectLabel })}</Notice> : null}
            <ErrorNote error={saving.error} />
          </div>
        </details>
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
          <Notice tone="info">{t(project === HUB_SCOPE ? "chat.hubHereNotFit" : "chat.hereNotFit", { machine: here, project })}</Notice>
        ) : null}
        {machines.data && !fit.length ? <Notice tone="info">{t(local ? "chat.noMachineLocal" : project === HUB_SCOPE ? "chat.hubNoMachine" : "chat.noMachine", { project })}</Notice> : null}
        <CommandInput project={project} text={text} onText={setText} onSend={send} onPaste={att.onPaste} maxLength={Math.max(0, MAX_TEXT - contextPrefix(context).length)} rows={4} />
        {withContext(text, context).length > MAX_TEXT ? <Notice tone="warn">{t("chat.messageTooLong")}</Notice> : null}
        <AttachmentBar att={att} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AttachButton att={att} />
            {t("chat.sendHint")}
          </span>
          <Button size="sm" type="submit" disabled={!machine || !text.trim() || withContext(text, context).length > MAX_TEXT || action.busy || (att.uploading || att.failed)}>
            <SendHorizontal />
            {t("chat.start")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </Card>
  );
}

function Conversation({ threadId, onBack, onChanged, onDeleted, panel, context }: { threadId: number; onBack: () => void; onChanged: () => void; onDeleted: () => void; panel: boolean; context: ChatPageContext | null }) {
  const { client, me } = useHive();
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
  const tasks = useQuery(async () => (thread ? client.call("tasks.list", thread.project === HUB_SCOPE ? {} : { project: thread.project }) : []), [client, thread?.project, ended]);
  const taskIds = (tasks.data ?? []).map((task) => task.id);
  const machines = useChatMachines([live ? 0 : tick]);
  const machine = thread ? machines.data?.find((m) => m.id === thread.machineId) : undefined;
  const manage = thread ? thread.project === HUB_SCOPE ? canUseHubChat(me) : allow(thread.project, "chatUse") : false;
  // What the leader proposes to do is approved apart from chatting (roadmap 25).
  const approve = thread ? thread.project === HUB_SCOPE ? canUseHubChat(me) : allow(thread.project, "chatApprove") : false;
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
  const [, setReuse] = useChatDraft<ChatMessage | null>(`thread:${threadId}:reuse`, null);
  const resend = retry ? async () => { setReuse(retry); } : undefined;
  const [newContent, setNewContent] = useState(false);
  const [, setSearchOpen] = useChatDraft(`searchOpen:${threadId}`, false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = list.current?.closest("[data-chat-thread]");
      if (document.activeElement !== document.body && !root?.contains(document.activeElement)) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => root?.querySelector<HTMLInputElement>("[data-chat-search] input")?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);
  const waiting = messages.flatMap((m) => m.actions).filter((a) => a.status === "proposed").length;
  const activeReply = messages.findLast(isLiveReply);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    else if (el) setNewContent(true);
  }, [messages.length, last?.text, last?.steps, last?.status]);
  useEffect(() => {
    const el = list.current;
    const content = el?.querySelector("ol");
    if (!el || !content) return;
    // Status cards load after the message; keep following their size only while the reader is at the end.
    const observer = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [threadId]);

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
    <Card className={cn("flex flex-col gap-0 py-0", "h-full min-h-0 flex-1 overflow-hidden")} data-chat-thread={threadId}>
      <header className="shrink-0 flex flex-wrap items-start gap-2 border-b px-4 py-3">
        <Button size="icon-sm" variant="ghost" className={panel ? undefined : "lg:hidden"} onClick={onBack} aria-label={t("chat.threads")}>
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
              <span className="font-mono">{thread.project === HUB_SCOPE ? t("chat.hubScope") : thread.project}</span> · {t("chat.startedBy", { who: thread.createdBy, time: formatTime(thread.createdAt) })}
            </p>
          ) : null}
        </div>
        {thread && manage ? <ThreadSettings thread={thread} onChanged={(th) => (setThread(th), onChanged())} /> : null}
      </header>
      <ThreadSearch threadId={threadId} messages={messages} onMatch={(id) => {
        stick.current = false;
        const el = list.current;
        const message = el?.querySelector<HTMLElement>(`[data-chat-message="${id}"]`);
        if (el && message) el.scrollTop += message.getBoundingClientRect().top - el.getBoundingClientRect().top;
      }} />
      <p role="status" aria-atomic="true" className="sr-only">{waiting ? t("chat.waitingActions", { count: waiting }) : activeReply ? t(activeReply.status === "pending" ? "chat.answering" : "chat.writing") : messages.length ? t("chat.replyReady") : ""}</p>
      <div
        data-chat-transcript
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (stick.current) setNewContent(false);
        }}
      >
        <ErrorNote error={error} />
        <ol className="mx-auto flex w-full max-w-(--reading-max) flex-col gap-6" aria-label={t("chat.transcript")}>
          {messages.map((m, index) =>
            m.role === "user" ? (
              <UserMessage key={m.id} message={m} onReuse={manage ? () => setReuse(m) : undefined} />
            ) : (
              <Reply
                key={m.id}
                message={m}
                statusProject={thread && messages[index - 1]?.role === "user" && isStatusCommand(messages[index - 1]?.text ?? "") ? thread.project : undefined}
                machine={thread?.machine ?? ""}
                taskIds={taskIds}
                manage={manage}
                approve={approve}
                onStopped={refresh}
                onDecided={(a) => { setMessages((ms) => withAction(ms, a)); refresh(); }}
                onDecidedAll={(replyId, actions) => setMessages((ms) => ms.map((x) => (x.id === replyId ? { ...x, actions } : x)))}
                onResend={m.id === last?.id ? resend : undefined}
              />
            ),
          )}
        </ol>
      </div>
      {newContent ? <Button variant="outline" size="sm" className="mx-auto mb-2" data-chat-new-content onClick={() => { stick.current = true; setNewContent(false); if (list.current) list.current.scrollTop = list.current.scrollHeight; }}>{t("chat.newContent")}</Button> : null}
      <footer className="max-h-[60%] shrink-0 flex flex-col gap-2 overflow-y-auto border-t px-4 py-3">
        {thread && machines.data && (!machine?.online || !machine.acceptsRuns) ? <Notice tone="warn">{t("chat.machineGone", { machine: thread.machine })}</Notice> : null}
        {thread && manage ? <Composer thread={thread} onSent={refresh} context={context} /> : thread ? <p className="text-xs text-muted-foreground">{t("chat.readOnly")}</p> : null}
      </footer>
      {thread ? <ChatSessionBar thread={thread} messages={messages} machine={machine} /> : null}
    </Card>
  );
}

/** A model picker (the selected provider's models, or the one already set) and an effort picker; empty is the plan's own. */
function ModelFields({
  model,
  effort,
  onModel,
  onEffort,
  idPrefix,
  kind,
  supportedModels,
}: {
  kind?: string;
  supportedModels?: string[] | null;
  model: string;
  effort: ChatEffort | "";
  onModel: (model: string) => void;
  onEffort: (effort: ChatEffort | "") => void;
  idPrefix: string;
}) {
  const t = useT();
  const codexModels = Object.values(DEFAULT_MODEL_TIERS).flatMap((row) => row.codex ? [row.codex.model] : []);
  const choices = supportedModels?.length ? supportedModels : kind === "codex" ? codexModels : kind === "claude" ? CHAT_MODEL_ALIASES : [...CHAT_MODEL_ALIASES, ...codexModels];
  const models = [...new Set([...choices, ...(model ? [model] : [])])];
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-model`}>{t("chat.model")}</Label>
        <NativeSelect id={`${idPrefix}-model`} size="sm" className="w-full min-h-11 data-[size=sm]:text-base md:min-h-0 md:data-[size=sm]:text-sm" value={model} onChange={(e) => onModel(e.target.value)}>
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
        <NativeSelect id={`${idPrefix}-effort`} size="sm" className="w-full min-h-11 data-[size=sm]:text-base md:min-h-0 md:data-[size=sm]:text-sm" value={effort} onChange={(e) => onEffort(e.target.value as ChatEffort | "")}>
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
  const machines = useChatMachines([]);
  const profile = machines.data?.find((m) => m.id === thread.machineId)?.profiles.find((p) => p.id === thread.profileId);
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
        <ModelFields model={model} effort={effort} onModel={setModel} onEffort={setEffort} idPrefix={`chat-${thread.id}`} kind={profile?.kind} supportedModels={profile?.supportedModels} />
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

function UserMessage({ message: m, onReuse }: { message: ChatMessage; onReuse?: () => void }) {
  const t = useT();
  return (
    <li data-chat-message={m.id} className="flex flex-col items-end gap-1">
      <MessageFiles files={m.files} />
      <div className="max-w-[92%] rounded-2xl rounded-br-sm bg-brand-soft px-3 py-2 text-sm whitespace-pre-wrap text-brand-soft-foreground wrap-anywhere">{m.text}</div>
      <span className="text-xs text-muted-foreground">
        {m.author} · {formatTime(m.createdAt)}
        {onReuse ? <Button size="sm" variant="ghost" onClick={onReuse}>{t("chat.reuseMessage")}</Button> : null}
      </span>
    </li>
  );
}

function Reply({
  message: m,
  statusProject,
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
  statusProject?: string;
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
  usePoll(live ? LIVE_MS : null);
  const elapsed = turnSeconds(m.createdAt, m.finishedAt ?? Date.now());
  return (
    <li data-chat-message={m.id} className="flex flex-col items-start gap-2">
      <div className="flex w-full min-w-0 flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden />
          <span className="font-mono">{m.author}</span>
          {m.status ? <Badge tone={REPLY_TONE[m.status] ?? "neutral"}>{t(`replyStatus.${m.status}`)}</Badge> : null}
          {m.costUsd !== null ? <span>{t("board.cost", { cost: formatUsd(m.costUsd) })}</span> : null}
          {live ? <span>{t("chat.turnElapsed", { seconds: elapsed })}</span> : null}
          {m.text && !live ? <CopyButton text={m.text} label={t("chat.copy")} className="ml-auto" /> : null}
        </div>
        {m.switchedFrom ? <Notice tone="info">{t("chat.switched", { from: m.switchedFrom, to: m.author.split("@")[0]! })}</Notice> : null}
        {statusProject ? <ChatStatusCard project={statusProject} /> : null}
        {m.text ? <ReplyMarkdown text={m.text} taskIds={taskIds} /> : live ? <p className="text-muted-foreground">{m.status === "pending" ? t("chat.waitingMachine", { machine }) : t("chat.writing")}</p> : null}
        {live && m.activity ? (
          <div className="flex items-center gap-2 text-xs text-info">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none" aria-hidden />
            <span className="wrap-anywhere">{m.activity}</span>
          </div>
        ) : null}
        <AgentSteps replyId={m.id} steps={m.steps} />
        {m.actions.length ? <ActionList reply={m} taskIds={taskIds} manage={approve} onDecided={onDecided} onDecidedAll={onDecidedAll} /> : null}
        {m.error ? <div className="text-xs text-destructive wrap-anywhere">{requestErrorText(m.error)}</div> : null}
        {onResend ? (
          <div>
            <Button size="sm" variant="outline" className="h-7" disabled={action.busy} onClick={() => void action.run(onResend)}>
              <RotateCcw />
              {t("chat.retryDraft")}
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
  const [planDispatch, setPlanDispatch] = useState<Record<string, boolean>>({});
  const waiting = reply.actions.filter((a) => a.status === "proposed").length;
  const decideAll = (accept: boolean) =>
    void act.run(async () => {
      const actions = await client.call("chat.decideAll", { replyId: reply.id, accept, autoDispatch: planDispatch });
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
          <ActionItem key={a.id} action={a} taskIds={taskIds} manage={manage} onDecided={onDecided} autoDispatch={planDispatch[String(a.id)] ?? true} onAutoDispatch={value => setPlanDispatch(old => ({ ...old, [String(a.id)]: value }))} />
        ))}
      </ul>
      {stopped && waiting ? <Notice tone="warn">{t("chat.stoppedAll")}</Notice> : null}
      <ErrorNote error={act.error} />
    </section>
  );
}

/**
 * Roadmap 60d: what a plan makes when someone presses Start, all read before it runs: the spec, each task with what
 * "done" means and what it waits for, and the batches the work is expected to land in.
 */
function PlanCard({ plan, action: a, taskIds }: { plan: ChatPlan; action: ChatAction; taskIds: string[] }) {
  const t = useT();
  const made = a.status === "done";
  // Wider tap targets on a phone only: on a desktop the links sit in the text.
  const tap = "inline-flex min-h-11 items-center md:min-h-0";
  return (
    <div className="flex min-w-0 flex-col gap-2 wrap-anywhere" data-plan={plan.spec.key}>
      {/* Where the spec goes, outside the fold: once made, the link to it is what the card is for. */}
      <div>
        {t("chat.planSpec")}:{" "}
        {made && a.result?.specKey ? (
          <a className={cn(LINK, tap, "font-mono text-[0.9em]")} href={`#/docs?doc=${encodeURIComponent(a.result.specKey)}`}>
            {a.result.specKey}
          </a>
        ) : (
          <span className="font-mono text-[0.9em] text-muted-foreground">{plan.spec.key}</span>
        )}
      </div>
      <details className="rounded-md bg-background/60 p-2">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium md:min-h-0">{plan.spec.title}</summary>
        <ReplyMarkdown text={plan.spec.content} taskIds={taskIds} />
      </details>
      <div className="font-medium">{t("chat.planTasks")}</div>
      <ul className="flex flex-col gap-1.5">
        {plan.tasks.map((item) => {
          const service = item.project ?? plan.project ?? a.project;
          const where = [
            service !== a.project ? t("chat.actionService", { project: service }) : null,
            item.dependsOn.length ? t("chat.actionDeps", { ids: item.dependsOn.join(", ") }) : null,
          ].filter(Boolean);
          return (
            <li key={item.id} className="flex flex-col gap-0.5 rounded-md bg-background/60 p-2" data-plan-task={item.id}>
              <div>
                {made || taskIds.includes(item.id) ? (
                  <a className={cn(LINK, tap, "font-mono text-[0.9em]")} href={`#/tasks?task=${encodeURIComponent(item.id)}`}>
                    {item.id}
                  </a>
                ) : (
                  <span className="font-mono text-[0.9em]">{item.id}</span>
                )}
                : <span className="font-medium">{item.title}</span>
              </div>
              {where.length ? <div className="text-muted-foreground">{where.join(" · ")}</div> : null}
              <p className="whitespace-pre-wrap">{t("chat.planAcceptance", { text: item.acceptance })}</p>
            </li>
          );
        })}
      </ul>
      <div className="font-medium">{t("chat.planBatches")}</div>
      <p className="text-muted-foreground">{t("chat.planCreateHint")}</p>
      <ol className="flex list-inside list-decimal flex-col gap-0.5">
        {plan.batches.map((batch, i) => (
          <li key={i}>
            {batch.title}: <span className="font-mono text-[0.9em]">{batch.taskIds.join(", ")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ResearchCard({ action: a, manage, onChanged }: { action: ChatAction; manage: boolean; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const act = useAction();
  const input = a.input as unknown as ResearchInput;
  const id = a.result?.researchId;
  const [terminal, setTerminal] = useState(false);
  const tick = usePoll(id && !terminal ? LIVE_MS : null);
  const query = useQuery(() => id ? client.call("research.get", { id }) : Promise.resolve(null), [client, id, tick]);
  const research = query.data;
  useEffect(() => { setTerminal(!!research && ["done", "failed", "cancelled"].includes(research.status)); }, [research?.status]);
  const [preview, setPreview] = useState(false);
  const [sent, setSent] = useState(false);
  const [drafted, setDrafted] = useState(false);
  const [, setReuse] = useChatDraft<Pick<ChatMessage, "text" | "files"> | null>(`thread:${a.threadId}:reuse`, null);
  const file = useQuery(() => preview && research?.artifactId ? client.call("artifacts.get", { id: research.artifactId, maxBytes: 1 }).then(got => { if (!got) throw new Error(t("chat.gone")); return got.artifact; }) : Promise.resolve(null), [client, preview, research?.artifactId]);
  const convert = () => void act.run(async () => {
    if (!research) return;
    const prompt = t("chat.researchPlanPrompt", { topic: input.topic, doc: research.docKey, recommendations: research.recommendations });
    const current = await client.call("chat.get", { threadId: a.threadId });
    if (!current) throw new Error(t("chat.gone"));
    if (current.thread.busy) {
      setReuse({ text: prompt, files: [] });
      setDrafted(true);
      return;
    }
    await sendResearchPlan(client, a.threadId, prompt, t("chat.gone"));
    setSent(true);
    onChanged();
  });
  return (
    <div className="flex min-w-0 flex-col gap-2 wrap-anywhere" data-research={id ?? "proposed"}>
      <div className="text-muted-foreground">{t("chat.researchScope")}: {t(`chat.researchScopeValues.${input.scope}`)}{input.system ? ` · ${input.system}` : ""} · {t("chat.researchFormat")}: {t(`chat.researchFormatValues.${input.format}`)}</div>
      <div>{t("chat.researchRequestedSources")}: {input.sources.map(s => t(`chat.researchSourceValues.${s}`)).join(", ")}</div>
      <div className="font-medium">{t("chat.researchQuestions")}</div>
      <ul className="list-inside list-disc">{input.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      {id ? <p role="status" aria-live="polite">{research ? t(`chat.researchStatus.${research.status}`) : t("artifacts.loading")}</p> : null}
      {research?.artifactId ? <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="research-touch-target" aria-expanded={preview} onClick={() => setPreview(v => !v)}>{t("chat.researchReport")} · report.md</Button>
        <a className={cn(LINK, "research-touch-target inline-flex items-center")} href={`#/artifacts?artifact=${research.artifactId}`}>{t("artifacts.title")}</a>
      </div> : null}
      {preview && file.loading ? <p role="status">{t("artifacts.loading")}</p> : null}
      {preview && file.data ? <ArtifactPreview artifact={file.data} onClose={() => setPreview(false)} /> : null}
      {research?.sources.length ? <div><div className="font-medium">{t("chat.researchSources")}</div><ul className="list-inside list-disc">{research.sources.map((s, i) => <li key={i}>{s}</li>)}</ul></div> : null}
      {research?.proposalId ? <a className={cn(LINK, "research-touch-target inline-flex items-center")} href={`#/proposals?proposal=${research.proposalId}`}>{t("chat.researchDraft")} · {research.docKey}</a> : null}
      {research ? <a className={cn(LINK, "research-touch-target inline-flex items-center")} href={`#/runs?run=${encodeURIComponent(`${research.machineId}/${research.runId}`)}`}>{t("nav.runs")} · {research.runId}</a> : null}
      {research?.status === "done" && research.recommendations.trim() && manage ? <Button size="sm" className="research-touch-target" disabled={act.busy || sent} onClick={convert}>{t("chat.researchConvert")}</Button> : null}
      {sent ? <p role="status">{t("chat.researchConverted")}</p> : null}
      {drafted ? <p role="status">{t("chat.busy")}</p> : null}
      <ErrorNote error={query.error ?? file.error ?? act.error ?? research?.error} />
    </div>
  );
}

/** One action a leader proposed: what it does, why, and (for a manager, while proposed) confirm or set aside. */
export function ActionItem({ action: a, taskIds, manage, onDecided, autoDispatch: controlledDispatch, onAutoDispatch }: { action: ChatAction; taskIds: string[]; manage: boolean; onDecided: (action: ChatAction) => void; autoDispatch?: boolean; onAutoDispatch?: (value: boolean) => void }) {
  const { client } = useHive();
  const t = useT();
  const act = useAction();
  const [, setReuse] = useChatDraft<Pick<ChatMessage, "text" | "files"> | null>(`thread:${a.threadId}:reuse`, null);
  const task = actionTask(a);
  const plan = a.kind === "plan.create" ? (a.input as unknown as ChatPlan) : null;
  const [localDispatch, setLocalDispatch] = useState(true);
  const autoDispatch = controlledDispatch ?? localDispatch;
  const setAutoDispatch = onAutoDispatch ?? setLocalDispatch;
  const input = a.input as Record<string, string | number | boolean | string[] | null | undefined>;
  const decide = (accept: boolean) =>
    void act.run(async () => {
      onDecided(await client.call("chat.decide", { actionId: a.id, accept, ...(plan ? { autoDispatch } : {}) }));
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
        <Badge tone="neutral" className="h-auto max-w-full whitespace-normal"><span className="wrap-anywhere" data-action-project={a.project}>{a.project === HUB_SCOPE ? t("chat.actionHub") : t("chat.actionService", { project: a.project })}</span></Badge>
        {/* Roadmap 29c: the project lets its leader run this kind alone, as whoever sent the message. */}
        {a.auto ? <Badge tone="info">{t("chat.autoRan", { who: a.decidedBy ?? "?" })}</Badge> : null}
        <span className="min-w-0 text-sm wrap-anywhere">
          {a.kind === "research.start" ? `${t("chat.researchTitle")}: ${String(input.topic)}` : plan ? (
            `${t("chat.planTitle")}: ${plan.spec.title}`
          ) : a.kind === "task.create" ? (
            <>
              {t("chat.actionCreate")} {a.status === "done" || (task && taskIds.includes(task)) ? taskLink : <span className="font-mono text-[0.9em]">{task}</span>}: {String(input.title ?? "")}
            </>
          ) : a.kind === "task.update" ? (
            <>
              {t("chat.actionMove")} {taskLink} → {t(`taskStatus.${String(input.status)}` as never)}
            </>
          ) : a.kind === "task.classify" ? (
            <>
              {t("chat.actionClassify")} {taskLink} ·{" "}
              {(
                [
                  ["kind", input.taskKind],
                  ["size", input.size],
                  ["risk", input.risk],
                ] as const
              )
                .filter(([, v]) => typeof v === "string")
                .map(([field, v]) => `${t(`taskClass.${field}`)}: ${t(`taskClass.${field}Values.${String(v)}` as never)}`)
                .join(" · ")}
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
      {a.kind === "research.start" ? <ResearchCard action={a} manage={manage} onChanged={() => onDecided(a)} /> : null}
      {plan ? <PlanCard plan={plan} action={a} taskIds={taskIds} /> : null}
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
          {plan ? <label className="flex min-h-11 w-full items-center gap-2 text-sm"><input type="checkbox" checked={autoDispatch} onChange={e => setAutoDispatch(e.target.checked)} disabled={act.busy} data-plan-auto-dispatch />{t("chat.planAutoDispatch")}</label> : null}
          <Button size="sm" className="min-h-11 min-w-11 md:h-7 md:min-h-0" disabled={act.busy} onClick={() => decide(true)}>
            <Check />
            {t(plan ? "chat.planDo" : "chat.confirm")}
          </Button>
          {plan ? <Button size="sm" variant="outline" disabled={act.busy} onClick={() => setReuse({ text: t("chat.revisePlan", { key: plan.spec.key }), files: [] })}>{t("chat.requestChanges")}</Button> : null}
          <Button size="sm" variant="ghost" className="min-h-11 min-w-11 md:h-7 md:min-h-0" disabled={act.busy} onClick={() => decide(false)}>
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

function Composer({ thread, onSent, context }: { thread: ChatThread; onSent: () => void; context: ChatPageContext | null }) {
  const { client } = useHive();
  const t = useT();
  const [text, setText] = useChatDraft(`thread:${thread.id}:text`, "");
  const action = useAction();
  const att = useAttachments(thread.project, `thread:${thread.id}:files`);
  const [reuse, setReuse] = useChatDraft<Pick<ChatMessage, "text" | "files"> | null>(`thread:${thread.id}:reuse`, null);
  const applyReuse = (append: boolean) => {
    if (!reuse) return;
    setText(append && text ? `${text}\n\n${reuse.text}` : reuse.text);
    if (!append) att.clear();
    att.reuse(reuse.files);
    setReuse(null);
  };
  const send = () => {
    if (!text.trim() || withContext(text, context).length > MAX_TEXT || thread.busy || action.busy || (att.uploading || att.failed)) return;
    void action.run(async () => {
      await client.call("chat.send", { project: thread.project, threadId: thread.id, text: withContext(text, context), files: att.ids });
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
      {reuse ? <section data-chat-reuse className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-xs" aria-label={t("chat.reuseTitle")}>
        <p className="font-medium">{t("chat.reuseTitle")}</p>
        <p>{t("chat.reuseHint")}</p>
        <p className="line-clamp-3 whitespace-pre-wrap wrap-anywhere">{reuse.text}</p>
        <MessageFiles files={reuse.files} />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => applyReuse(false)}>{t("chat.replaceDraft")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => applyReuse(true)}>{t("chat.appendDraft")}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReuse(null)}>{t("chat.keepDraft")}</Button>
        </div>
      </section> : null}
      <CommandInput project={thread.project} text={text} onText={setText} onSend={send} onPaste={att.onPaste} maxLength={Math.max(0, MAX_TEXT - contextPrefix(context).length)} rows={2} />
      {withContext(text, context).length > MAX_TEXT ? <Notice tone="warn">{t("chat.messageTooLong")}</Notice> : null}
      <AttachmentBar att={att} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <AttachButton att={att} />
          <span id={`chat-send-hint-${thread.id}`}>{thread.busy ? t("chat.busy") : t("chat.sendHint")}</span>
        </span>
        <Button size="sm" type="submit" aria-describedby={`chat-send-hint-${thread.id}`} disabled={!text.trim() || withContext(text, context).length > MAX_TEXT || thread.busy || action.busy || (att.uploading || att.failed)}>
          <SendHorizontal />
          {t("chat.send")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </form>
  );
}


/** One composer for new and existing threads: selecting a shortcut never sends it. */
function CommandInput({ project, text, onText, onSend, onPaste, rows, maxLength = MAX_TEXT }: {
  project: string;
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  rows: number;
  maxLength?: number;
}) {
  const { client, projects } = useHive();
  const mobile = useMobileDetail("thread").mobile;
  const allow = useCan();
  const t = useT();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(text.length);
  const [draftError, setDraftError] = useState<string | null>(null);
  const firstLineEnd = text.indexOf("\n") < 0 ? text.length : text.indexOf("\n");
  const argument = dismissed || caret > firstLineEnd ? null : shortcutArgument(text);
  const runCommand = argument?.command === "cancel" || argument?.command === "retry" ? argument.command : null;
  const runs = useQuery(async () => runCommand ? client.call("runs.list", { ...(project === HUB_SCOPE ? {} : { project }), limit: 200 }) : [], [client, project, runCommand]);
  const commandQuery = !dismissed && /^\/[a-z]*$/i.test(text);
  const commands = dismissed ? [] : matchingShortcuts(text);
  const services = project === HUB_SCOPE ? projects.filter(p => allow(p, "chatUse")) : [project];
  const parameters = argument ? runCommand
    ? shortcutRuns(runs.data ?? [], runCommand, project, argument.query).map(run => ({ value: `${run.machineId}/${run.runId}`, label: `${run.runId} · ${run.taskId}`, detail: `${run.project} · ${run.machine} · ${run.taskTitle}` }))
    : services.filter(p => p.toLowerCase().includes(argument.query.toLowerCase())).map(p => ({ value: p, label: p, detail: t(`chat.shortcuts.description.${argument.command}`) })) : [];
  const options = commands.length ? commands.map(command => ({ value: command, label: `/${command}`, detail: t(`chat.shortcuts.description.${command}`), example: t(`chat.shortcuts.example.${command}`) })) : parameters.map(parameter => ({ ...parameter, example: "" }));
  const chosen = Math.min(active, Math.max(0, options.length - 1));
  const focusDraft = (draft: string) => requestAnimationFrame(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const placeholder = /\[[^\]]+\]/.exec(draft);
    const start = placeholder?.index ?? draft.length;
    el.setSelectionRange(start, start + (placeholder?.[0].length ?? 0));
    setCaret(start);
  });
  const selectCommand = (command: ChatShortcut) => {
    const draft = shortcutDraft(t(`chat.shortcuts.template.${command}`), text);
    if (draft.length > maxLength) return setDraftError(t("chat.shortcuts.tooLong", { max: MAX_TEXT }));
    setDraftError(null);
    onText(draft);
    setActive(0);
    setDismissed(false);
    focusDraft(draft);
  };
  const selectOption = (value: string) => {
    if (commands.length) return selectCommand(value as ChatShortcut);
    const draft = fillShortcutArgument(text, value);
    if (draft.length > maxLength) return setDraftError(t("chat.shortcuts.tooLong", { max: MAX_TEXT }));
    setDraftError(null);
    onText(draft);
    setDismissed(true);
    focusDraft(draft);
  };
  useEffect(() => {
    const option = document.getElementById(`${id}-option-${chosen}`);
    const menu = document.getElementById(`${id}-menu`);
    if (!option || !menu) return;
    const top = option.offsetTop - menu.offsetTop;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (top + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = top + option.offsetHeight - menu.clientHeight;
  }, [id, chosen, options.length]);
  return <div className="flex min-w-0 flex-col gap-2" data-chat-commands>
    <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t("chat.shortcuts.title")} data-chat-chips>
      <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => { onText(text || "/"); setDismissed(false); input.current?.focus(); }}>{t("chat.commandsOpen")}</Button>
      {CHAT_SHORTCUTS.slice(0, 4).map(command => <Button key={command} type="button" size="sm" variant="outline" className="shrink-0 max-md:min-h-(--control-h-touch)" data-chat-command={command} onClick={() => selectCommand(command)}>/{command}<span>{t(`chat.shortcuts.${command}`)}</span></Button>)}
    </div>
    <Label htmlFor={`${id}-input`}>{t("chat.message")}</Label>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t(mobile ? "chat.sendMobileHint" : "chat.shortcuts.hint")}</p>
    <div className="relative">
    {options.length || argument || commandQuery ? <div className="absolute bottom-full z-20 mb-2 w-full space-y-1 rounded-md border bg-card p-1 shadow-md" data-chat-command-menu>
      {options.length ? <div id={`${id}-menu`} role="listbox" aria-label={t(argument ? "chat.shortcuts.arguments" : "chat.shortcuts.title")} className="max-h-48 overflow-y-auto">
        {options.map((option, index) => <button type="button" role="option" aria-selected={index === chosen} id={`${id}-option-${index}`} key={option.value} tabIndex={-1} data-chat-suggestion={option.value} className={cn("flex min-h-(--control-h-touch) w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring", index === chosen && "bg-selected")} onMouseDown={e => e.preventDefault()} onClick={() => selectOption(option.value)}>
          <span className="font-mono wrap-anywhere">{option.label}</span><span className="text-xs wrap-anywhere">{option.detail}</span>{option.example ? <span className="text-xs text-muted-foreground wrap-anywhere">{option.example}</span> : null}
        </button>)}
      </div> : <p className="p-2 text-xs" role="status">{t(commandQuery ? "chat.shortcuts.noCommands" : runCommand && runs.loading ? "chat.shortcuts.loading" : "chat.shortcuts.noArguments")}</p>}
      {runCommand ? <ErrorNote error={runs.error} /> : null}
    </div> : null}
    <Textarea id={`${id}-input`} ref={input} rows={rows} maxLength={maxLength} className="max-h-48 max-md:text-base" placeholder={t("chat.placeholder")} aria-label={t("chat.message")} aria-describedby={`${id}-hint`} role="combobox" aria-expanded={options.length > 0} aria-autocomplete="list" aria-controls={options.length ? `${id}-menu` : undefined} aria-activedescendant={options.length ? `${id}-option-${chosen}` : undefined} value={text}
      onChange={e => { onText(e.target.value); setDraftError(null); setCaret(e.target.selectionStart); setActive(0); setDismissed(false); }} onSelect={e => setCaret(e.currentTarget.selectionStart)} onPaste={onPaste}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (options.length || argument || commandQuery) {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
          if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((chosen + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return; }
          if (options.length && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) { e.preventDefault(); selectOption(options[chosen]!.value); return; }
        }
        if (chatSubmitKey({ ...e, composing: e.nativeEvent.isComposing }, mobile)) { e.preventDefault(); onSend(); }
      }} />
    </div>
    {text.length > maxLength - 500 ? <p className="text-xs text-muted-foreground">{t("chat.textCount", { count: text.length, max: maxLength })}</p> : null}
    <ErrorNote error={draftError} />
  </div>;
}

/** The card is live hub data, so a leader's prose cannot invent the counters. */
function ChatStatusCard({ project }: { project: string }) {
  const { client, setScope } = useHive();
  const t = useT();
  const local = useLocalChat();
  const poll = usePoll(IDLE_MS);
  const status = useQuery(async () => {
    const [tasks, machines, cooldowns] = await Promise.all([
      client.call("tasks.list", project === HUB_SCOPE ? {} : { project }),
      local ? client.desktop!.chatMachine!().then(machine => machine ? [machine] : []) : client.call("machines.list", {}),
      client.call("cooldowns.list", {}),
    ]);
    const now = Date.now();
    const shown = machines.filter(machine => project === HUB_SCOPE || machine.projects.includes(project));
    return { counts: chatStatusCounts(tasks, machines, project), quota: quotaTotals(quotaRows(shown, cooldowns, now)), time: new Date(now).toISOString() };
  }, [client, project, local, poll]);
  const data = status.data;
  return <section className="space-y-2 rounded-lg border bg-muted/30 p-3" aria-label={t("chat.statusCard.title")} data-chat-status={project}>
    <h3 className="font-medium">{t("chat.statusCard.title")}</h3>
    <p className="text-xs text-muted-foreground">{data ? t("chat.statusCard.live", { scope: project === HUB_SCOPE ? t("chat.hubScope") : project, time: formatTime(data.time) }) : t(status.error ? "chat.statusCard.unavailable" : "chat.statusCard.loading")}</p>
    <ErrorNote error={status.error} />
    {status.error ? <Button type="button" size="sm" variant="outline" className="max-md:min-h-(--control-h-touch)" onClick={status.reload}>{t("chat.statusCard.retry")}</Button> : null}
    {data ? <>
      <dl className="grid grid-cols-2 gap-2">
        {(["done", "running", "review", "blocked"] as const).map(key => <div key={key} className="rounded-md border bg-card p-2"><dt className="text-xs text-muted-foreground">{t(`chat.statusCard.${key}`)}</dt><dd className="text-lg font-semibold" data-chat-status-count={key}>{data.counts[key]}</dd></div>)}
      </dl>
      <div><p className="text-xs text-muted-foreground">{t(project === HUB_SCOPE ? "chat.statusCard.hubQuota" : "chat.statusCard.quota")}</p><p>{t("chat.statusCard.capacity", { count: data.quota.available, slots: data.quota.slots })}</p><p className="text-xs">{data.quota.full === null ? t("quota.noEstimate") : t("quota.estimate", { count: data.quota.full })}{data.quota.unknown ? ` · ${t("quota.missing", { count: data.quota.unknown })}` : ""}</p></div>
      <div className="flex flex-wrap gap-x-3">
        <a className={cn(LINK, "inline-flex min-h-(--control-h-touch) items-center")} onClick={() => setScope(project === HUB_SCOPE ? { kind: "all" } : { kind: "project", project })} href={project === HUB_SCOPE ? "#/tasks" : `#/tasks?project=${encodeURIComponent(project)}`}>{t("chat.statusCard.tasks")}</a>
        {project !== HUB_SCOPE ? <a className={cn(LINK, "inline-flex min-h-(--control-h-touch) items-center")} href={`#/pipeline?project=${encodeURIComponent(project)}`}>{t("chat.statusCard.pipeline")}</a> : null}
        <a className={cn(LINK, "inline-flex min-h-(--control-h-touch) items-center")} onClick={() => setScope(project === HUB_SCOPE ? { kind: "all" } : { kind: "project", project })} href="#/runs">{t("nav.runs")}</a>
        <a className={cn(LINK, "inline-flex min-h-(--control-h-touch) items-center")} onClick={() => setScope(project === HUB_SCOPE ? { kind: "all" } : { kind: "project", project })} href="#/quota">{t("quota.title")}</a>
      </div>
    </> : null}
  </section>;
}
