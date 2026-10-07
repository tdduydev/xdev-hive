import { WorktreeManager } from "#ui/components/Worktrees.tsx";
// Bản đồ agent (roadmap 31b): each machine a column of its profiles, each profile with the runs it has now and what
// the agent is doing, the machine's queue under them, and the open batches on the right. Profiles picked here get one
// prompt (one agent, or a fan-out) or the tasks picked next on the Task page.
import { useState, type KeyboardEvent } from "react";
import { ListChecks, Ellipsis } from "lucide-react";
import { cn } from "cn";
import { expandPackage, toolCommands } from "@xdev-hive/core";
import type { Machine, QuotaCooldown, ReportedProfile, RunGroup, RunRecord, RunRequest } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { AssignedQueue } from "#ui/components/AgentAssignment.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { usageAsOf } from "#ui/lib/agents.ts";
import { encodeTargets, machineCards, type AgentTarget, type ProfileCard, type ProfileState } from "#ui/lib/agentmap.ts";
import { shortAgo } from "#ui/lib/inbox.ts";

import { SummaryStrip } from "#ui/components/SummaryStrip.tsx";
import { AttentionList, type AttentionItem } from "#ui/components/AttentionList.tsx";
import { QuotaBars } from "#ui/components/QuotaBars.tsx";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "#ui/components/ui/sheet.tsx";
import { meterTone } from "#ui/lib/agents.ts";

const STATE_KIND: Record<ProfileState, ChipKind> = {
  offline: "neutral",
  off: "neutral",
  noCli: "danger",
  signedOut: "danger",
  running: "running",
  overLimit: "warning",
  resting: "warning",
  ready: "success",
};

/** A picked profile takes work only on a machine that is on, takes runs from the hub, and can start its CLI. */
const takesWork = (m: Machine, c: ProfileCard) => m.online && m.acceptsRuns && !m.duplicate && !["off", "noCli", "signedOut"].includes(c.state);

const targetKey = (x: AgentTarget) => `${x.machineId}|${x.profileId}`;

export function AgentMap({
  machines,
  cooldowns,
  runs,
  requests,
  groups,
  onChanged,
}: {
  machines: Machine[];
  cooldowns: QuotaCooldown[];
  /** The hub's run records, for what each running agent is doing. */
  runs: RunRecord[];
  requests: RunRequest[];
  groups: RunGroup[];
  onChanged: () => void;
}) {
  const { projects } = useHive();
  const t = useT();
  const allow = useCan();
  const now = Date.now();
  const dispatchers = projects.filter((p) => allow(p, "runDispatch"));
  const [picks, setPicks] = useState<AgentTarget[]>([]);
  const picked = (x: AgentTarget) => picks.some((p) => targetKey(p) === targetKey(x));
  const toggle = (x: AgentTarget) => setPicks((all) => (picked(x) ? all.filter((p) => targetKey(p) !== targetKey(x)) : [...all, x]));
  const activity = new Map(runs.map((r) => [`${r.machineId}/${r.runId}`, r.activity]));
  const open = groups.filter((g) => !g.closedAt);
  const [filter, setFilter] = useState(() => new URLSearchParams(location.hash.split("?")[1]).get("map") ?? "");
  const entries = machines.flatMap(machine => machineCards(machine, cooldowns, now).cards.map(card => ({ machine, card })));
  const needsHand = (c: ProfileCard) => ["noCli", "signedOut", "overLimit", "resting", "offline"].includes(c.state) || [c.profile.sessionPercent, c.profile.weekPercent].some(n => n != null && meterTone(n, 100) !== "ok");
  const attention: AttentionItem[] = entries.filter(({ card }) => needsHand(card)).map(({ machine: m, card: c }) => ({
    id: `${m.id}/${c.profile.id}`, level: ["noCli", "signedOut"].includes(c.state) ? "danger" : "warning",
    levelLabel: t(["ready", "running"].includes(c.state) ? "dashboardAgents.attention" : `agentMap.state.${c.state}`, { n: c.running, max: c.max }),
    text: `${c.profile.label} · ${m.machine}${c.restingUntil ? ` · ${formatTime(c.restingUntil)}` : ""}${c.profile.sessionPercent != null ? ` · ${c.profile.sessionPercent}%` : ""}`,
    action: ["overLimit", "resting", "ready", "running"].includes(c.state)
      ? <a className="inline-flex min-h-11 items-center text-sm underline md:min-h-7" href={`#/machines?tab=quota&machine=${encodeURIComponent(m.id)}&kind=${encodeURIComponent(c.profile.kind)}`}>{t("dashboardAgents.quota")}</a>
      : <ProfileHelp machine={m} card={c} />,
  }));
  const matches = (m: Machine, c: ProfileCard) => !filter || (filter === "ready" ? c.state === "ready" && takesWork(m, c) : filter === "running" ? c.running > 0 : filter === "attention" ? needsHand(c) : true);
  const visible = machines.filter(m => !filter || (filter === "queue"
    ? machineCards(m, cooldowns, now).queue.length > 0 || requests.some(r => r.machineId === m.id && r.status === "pending")
    : entries.some(e => e.machine.id === m.id && matches(m, e.card))));
  const summaryHref = (value: string) => `#/machines?map=${value}`;


  return (
    <div className="flex flex-col gap-3">
      {attention.length ? <section className="flex flex-col gap-2"><h2 className="text-sm font-semibold">{t("dashboardAgents.attention")}</h2><AttentionList items={attention} label={t("dashboardAgents.attention")} /><a className="min-h-11 content-center text-xs underline md:min-h-7" href="#/today">{t("dashboardAgents.today")}</a></section> : null}
      <div onClick={e => { const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-summary]"); if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); setFilter(link.dataset.summary ?? ""); } }}>
        <SummaryStrip label={t("dashboardAgents.summary")} items={[
          { id: "ready", label: t("dashboardAgents.ready"), value: `${entries.filter(e => e.card.state === "ready" && takesWork(e.machine, e.card)).length}/${entries.length}`, href: summaryHref("ready") },
          { id: "running", label: t("dashboardAgents.running"), value: entries.reduce((n, e) => n + e.card.running, 0), href: summaryHref("running") },
          { id: "queue", label: t("dashboardAgents.queue"), value: machines.reduce((n, m) => n + machineCards(m, cooldowns, now).queue.length, 0) + requests.filter(r => r.status === "pending").length, href: summaryHref("queue") },
          { id: "attention", label: t("dashboardAgents.attention"), value: attention.length, href: summaryHref("attention"), tone: attention.length ? "warning" : undefined },
        ]} />
      </div>
      {filter ? <Button variant="outline" className="self-start min-h-11 md:min-h-7" onClick={() => setFilter("")}>{t("dashboardAgents.all")}</Button> : null}
      {picks.length ? (
        <div role="toolbar" aria-label={t("agentMap.picked", { count: picks.length })} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-inverse px-3 py-2 text-[13px] text-fg-inverse">
          <span className="font-semibold">{t("agentMap.picked", { count: picks.length })}</span>
          <span className="flex-1" />
          <a href={`#/tasks?agents=${encodeURIComponent(encodeTargets(picks))}`} data-map-batch className="inline-flex h-11 md:h-7 items-center gap-1.5 rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring">
            <ListChecks className="size-3.5" />
            {t("agentMap.giveTasks", { count: picks.length })}
          </a>
          <button type="button" onClick={() => setPicks([])} className="h-11 md:h-7 cursor-pointer rounded-sm px-2 text-xs underline">
            {t("agentMap.clear")}
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] items-start gap-3 pb-2">
        {visible.map((m) => (
          <MachineColumn
            key={m.id}
            machine={m}
            cooldowns={cooldowns}
            activity={activity}
            queued={requests.filter((r) => r.machineId === m.id && r.status === "pending")}
            now={now}
            canPick={m.projects.some((p) => dispatchers.includes(p))}
            showCard={c => matches(m, c)}
            picked={picked}
            onToggle={toggle}
            onChanged={onChanged}
          />
        ))}
      </div>

      <a href="#/runs?tab=batches" className="min-h-11 content-center text-sm underline md:min-h-7">{t("dashboardAgents.batches", { count: open.length })}</a>


    </div>
  );
}

function ProfileHelp({ machine: m, card: c }: { machine: Machine; card: ProfileCard }) {
  const t = useT();
  const key = c.state === "signedOut" ? "loginHelp" : c.state === "noCli" ? "cliHelp" : "offlineHelp";
  return <Sheet>
    <SheetTrigger asChild><Button variant="outline" className="min-h-11 md:min-h-7">{t("dashboardAgents.help")}</Button></SheetTrigger>
    <SheetContent>
      <SheetHeader><SheetTitle>{c.profile.label} · {m.machine}</SheetTitle><SheetDescription>{t(`agentMap.state.${c.state}`)}</SheetDescription></SheetHeader>
      <p className="px-4 text-sm/6 wrap-anywhere">{t(`dashboardAgents.${key}`, { machine: m.machine, profile: c.profile.label })}</p>
    </SheetContent>
  </Sheet>;
}

function MachineColumn({
  machine: m,
  cooldowns,
  activity,
  queued,
  now,
  canPick,
  showCard,
  picked,
  onToggle,
  onChanged,
}: {
  machine: Machine;
  cooldowns: QuotaCooldown[];
  activity: Map<string, string | null>;
  queued: RunRequest[];
  now: number;
  canPick: boolean;
  showCard: (card: ProfileCard) => boolean;
  picked: (x: AgentTarget) => boolean;
  onToggle: (x: AgentTarget) => void;
  onChanged: () => void;
}) {
  const { me } = useHive();
  const t = useT();
  const { cards, queue } = machineCards(m, cooldowns, now);
  return (
    <section className={cn("flex min-w-0 w-full flex-col gap-2 rounded-xl border border-line-default bg-sunken p-2.5", !m.online && "opacity-75", !m.profiles.length && "col-span-full")} aria-label={m.machine} data-map-machine={m.machine} data-map-machine-id={m.id}>
      <div className="flex flex-col gap-0.5 px-1">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", m.duplicate ? "bg-danger-solid" : m.online ? "bg-success-solid" : "bg-neutral-solid")} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-fg-strong">{m.machine}</span>
          {m.version ? <span className="font-mono text-xs text-fg-muted">v{m.version}</span> : null}
          <MachineManagement machine={m} onChanged={onChanged} />
        </div>
        <span className="text-xs text-fg-muted">
          {m.duplicate ? t("machineState.duplicate") : m.online ? t("machineState.online") : t("machines.lastSeen", { time: formatTime(m.lastSeen) })}
          {" · "}
          {m.profiles.length ? m.acceptsRuns ? t("machines.acceptsRuns") : t("agentMap.notAccepting") : t("agentMap.noProfiles")}
        </span>
      </div>

      {cards.filter(showCard).map((c) => {
        const target = { machineId: m.id, profileId: c.profile.id };
        return (
          <div key={c.profile.id} className="flex min-w-0 flex-col gap-2">
          <ProfileCardView
            key={c.profile.id}
            card={c}
            machine={m}
            activity={activity}
            now={now}
            pick={canPick && takesWork(m, c) ? { on: picked(target), toggle: () => onToggle(target) } : null}
          />
          <AssignedQueue machineId={m.id} profileId={c.profile.id} />
          </div>
        );
      })}
      <AssignedQueue machineId={m.id} profileId={null} />
      {queue.length || queued.length ? (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed border-line-default p-2">
          <span className="text-xs font-medium text-fg-secondary">{t("agentMap.queue", { count: queue.length + queued.length })}</span>
          {queue.map((r) => (
            <span key={r.runId} className="truncate text-xs text-fg-muted" title={r.taskTitle}>
              <span className="font-mono">{r.taskId}</span> {r.taskTitle}
            </span>
          ))}
          {queued.map((r) => (
            <span key={`q${r.id}`} className="truncate text-xs text-fg-muted" title={r.taskTitle ?? undefined}>
              <span className="font-mono">{r.taskId}</span> {t("agentMap.waitingMachine", { profile: r.profileId ?? t("board.auto") })}
            </span>
          ))}
        </div>
      ) : null}
      {!mayManage(me, m) ? <MachineTools machine={m} /> : null}
    </section>
  );
}

function MachineManagement({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  if (!mayManage(me, m)) return null;
  return <Sheet>
        <SheetTrigger asChild><Button data-map-manage={m.machine} variant="ghost" size="icon" className="size-11 shrink-0 md:size-8" title={t("dashboardAgents.manage", { machine: m.machine })} aria-label={t("dashboardAgents.manage", { machine: m.machine })}><Ellipsis aria-hidden="true" /></Button></SheetTrigger>
        <SheetContent className="overflow-y-auto max-md:[&_button]:min-h-11 max-md:[&_input]:min-h-11">
          <SheetHeader><SheetTitle>{t("dashboardAgents.manage", { machine: m.machine })}</SheetTitle><SheetDescription>{t("dashboardAgents.manageHint")}</SheetDescription></SheetHeader>
          <div className="flex min-w-0 flex-col gap-3 px-4 pb-4">
      <MachineTools machine={m} />
      {mayManage(me, m) ? <WorktreeManager machine={m} /> : null}
      {mayManage(me, m) && m.profiles.length ? (
        <details className="px-1 text-xs">
          <summary className="min-h-11 cursor-pointer content-center text-fg-muted select-none md:min-h-7">{t("agentMap.manage")}</summary>
          <ProfileControls machine={m} onChanged={onChanged} />
        </details>
      ) : null}
      {me.role === "admin" && !m.online ? (
        <div className="px-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.call("machines.remove", { id: m.id });
                onChanged();
              })
            }
          >
            {t("machines.remove")}
          </Button>
        </div>
      ) : null}
          <ErrorNote error={action.error} /></div>
        </SheetContent>
      </Sheet>;

}

function ProfileCardView({
  card: c,
  machine: m,
  activity,
  now,
  pick,
}: {
  card: ProfileCard;
  machine: Machine;
  activity: Map<string, string | null>;
  now: number;
  pick: { on: boolean; toggle: () => void } | null;
}) {
  const t = useT();
  const p = c.profile;
  const waiting = m.profileChanges?.find((x) => x.profileId === p.id) ?? null;
  const label =
    c.state === "running"
      ? t("agentMap.state.running", { n: c.running, max: c.max })
      : c.state === "resting" && c.restingUntil
        ? t("agentMap.state.restingUntil", { time: new Date(c.restingUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
        : t(`agentMap.state.${c.state}`);
  const onKey = (e: KeyboardEvent) => {
    if (pick && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      pick.toggle();
    }
  };
  return (
    <div
      role={pick ? "checkbox" : undefined}
      aria-checked={pick ? pick.on : undefined}
      tabIndex={pick ? 0 : undefined}
      onClick={pick?.toggle}
      onKeyDown={onKey}
      data-map-profile={`${m.machine}/${p.id}`}
      data-map-state={c.state}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-surface p-2.5 outline-none",
        pick ? "cursor-pointer hover:border-fg-secondary focus-visible:focus-ring" : "",
        pick?.on ? "border-primary ring-2 ring-primary/30" : "border-line-default",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-strong" title={p.label}>
          {p.label}
        </span>
        <Chip kind={STATE_KIND[c.state]} small>
          {label}
        </Chip>
      </div>
      <span className="truncate font-mono text-xs text-fg-muted">
        {p.id} · {p.kind}
        {p.account ? ` · ${p.account}` : ""}
      </span>
      {/* A change asked on the web shows on the card until the machine reports it, the manage section closed or not. */}
      {waiting ? <span className="text-xs text-warning">{t("machines.profileWaiting", { who: waiting.requestedBy, time: formatTime(waiting.requestedAt) })}</span> : null}
      {p.sessionPercent != null || p.weekPercent != null ? (
        <QuotaBars profile={p} />
      ) : null}
      {p.sessionResets || p.weekResets || usageAsOf(p.usageCheckedAt) ? (
        <span data-usage-resets className="text-xs/4 text-fg-muted">
          {[
            p.sessionResets ? t("machines.sessionResets", { time: p.sessionResets }) : null,
            p.weekResets ? t("machines.weekResets", { time: p.weekResets }) : null,
            usageAsOf(p.usageCheckedAt) ? t("agents.usageAsOf", { time: formatTime(p.usageCheckedAt!) }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
      {c.runs.map((r) => {
        const doing = activity.get(`${m.id}/${r.runId}`);
        return (
          <a
            key={r.runId}
            href={`#/runs?run=${encodeURIComponent(r.runId)}`}
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col gap-0.5 rounded-md bg-sunken px-2 py-1.5 outline-none hover:bg-hover focus-visible:focus-ring"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className={cn("size-1.5 shrink-0 rounded-full", r.status === "running" ? "bg-running" : "bg-neutral-solid")} />
              <span className="font-mono text-fg-secondary">{r.taskId}</span>
              <span className="min-w-0 flex-1 truncate text-fg-strong">{r.taskTitle}</span>
              <span className="shrink-0 text-xs text-fg-muted">{shortAgo(r.since, now, t)}</span>
            </span>
            {doing ? <span className="line-clamp-2 text-xs/4 text-fg-muted">{doing}</span> : null}
          </a>
        );
      })}
    </div>
  );
}

function MachineTools({ machine: m }: { machine: Machine }) {
  const { client } = useHive();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const query = useQuery(() => open ? client.call("machines.tools", { machineId: m.id }) : Promise.resolve(null), [client, m.id, m.lastSeen, open, tick]);
  const action = useAction();
  const access = query.data;
  return (
    <details data-machine-tools={m.machine} className="min-w-0 px-1 text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer items-center text-fg-secondary select-none md:min-h-7">{t("machines.toolsTitle")}</summary>
      <div aria-busy={query.loading || action.busy} className="flex min-w-0 flex-col gap-2 pt-2">
        <p className="m-0 text-xs/5 text-fg-muted">{t("machines.toolsHint")}</p>
        {query.loading ? <p role="status">{t("common.loading")}</p> : null}
        {access && !access.supported ? <p>{t("machines.toolsOldApp")}</p> : null}
        {access?.supported && !access.tools.length ? <p>{t("machines.toolsNone")}</p> : null}
        {access?.tools.map((tool) => {
          const pending = tool.approval && !tool.approval.appliedAt;
          const needsApproval = tool.trust === "new" || tool.trust === "changed";
          return (
            <div key={tool.id} data-machine-tool={tool.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-line-default bg-surface p-2">
              <span className="break-words font-medium">{tool.entry.name} · {tool.entry.package?.version ?? tool.id}</span>
              <Chip kind={needsApproval ? "warning" : "success"}>{t(`setup.toolTrust.${tool.trust}`)}</Chip>
              <pre className="m-0 whitespace-pre-wrap break-all rounded-md bg-code p-2 font-mono text-xs/5 text-code-fg">
                {toolCommands(tool.entry).map(([field, argv]) => `${field}: ${JSON.stringify(expandPackage(argv, tool.entry.package))}`).join("\n")}
                {tool.entry.plugin ? `\nplugin: ${tool.entry.plugin}` : ""}
              </pre>
              {Object.keys(tool.entry.env).length ? <p className="m-0 break-all text-fg-muted">{t("setup.toolEnv")}: {JSON.stringify(tool.entry.env)}</p> : null}
              {tool.entry.secretEnv.length ? <p className="m-0 break-words text-fg-muted">{t("setup.toolSecretEnv", { names: tool.entry.secretEnv.join(", ") })}</p> : null}
              {tool.approval ? <p role="status" className="m-0 text-xs/5 text-fg-muted">{t(pending ? "machines.toolApprovalPending" : "machines.toolApproved", { who: tool.approval.approvedBy, time: formatTime(tool.approval.approvedAt) })}</p> : null}
              {access.canApprove && needsApproval && !pending ? (
                <Button size="sm" variant="outline" className="min-h-11 whitespace-normal md:min-h-7" data-approve-tool disabled={action.busy} onClick={() => void action.run(async () => {
                  await client.call("machines.approveTool", { machineId: m.id, toolId: tool.id, hash: tool.hash });
                  setTick((v) => v + 1);
                })}>{t(action.busy ? "machines.toolApproving" : "machines.toolAllow")}</Button>
              ) : null}
            </div>
          );
        })}
        <ErrorNote error={query.error ?? action.error} />
      </div>
    </details>
  );
}

/** Asked 2/10 (roadmap 18d): a subscription is someone's own account, so only hub admins and the machine's owner. */
function mayManage(me: ReturnType<typeof useHive>["me"], m: Machine): boolean {
  return (me.role === "admin" && !me.access) || (!!me.user && me.user.username === m.owner);
}

/** On/off and priority of each profile; the machine applies a change at its next heartbeat. */
function ProfileControls({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const set = (p: ReportedProfile, change: { enabled?: boolean; priority?: number }) =>
    void action.run(async () => {
      await client.call("machines.setProfile", { machineId: m.id, profileId: p.id, ...change });
      onChanged();
    });
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-dashed p-2">
      {m.profiles.map((p) => {
        const waiting = m.profileChanges?.find((c) => c.profileId === p.id) ?? null;
        // A change on its way shows as asked, so the switch does not flip back until the machine reports it.
        const on = waiting?.enabled ?? p.enabled;
        const old = p.priority === undefined;
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Switch checked={on} disabled={old || action.busy} onCheckedChange={(v) => set(p, { enabled: v })} aria-label={t("machines.profileOn", { profile: p.id })} />
            <span className="min-w-20 font-mono text-xs">{p.id}</span>
            {old ? (
              <span className="text-xs text-muted-foreground">{t("machines.profileOldApp")}</span>
            ) : (
              <PriorityInput key={`${p.id}-${waiting?.priority ?? p.priority}`} value={waiting?.priority ?? p.priority!} busy={action.busy} label={t("machines.profilePriority")} onSave={(v) => set(p, { priority: v })} />
            )}
            {waiting ? <span className="text-xs text-warning">{t("machines.profileWaiting", { who: waiting.requestedBy, time: formatTime(waiting.requestedAt) })}</span> : null}
          </div>
        );
      })}
      <span className="text-xs text-muted-foreground">{t("machines.profileHint")}</span>
      <ErrorNote error={action.error} />
    </div>
  );
}

function PriorityInput({ value, busy, label, onSave }: { value: number; busy: boolean; label: string; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const save = () => {
    const v = Number(draft);
    if (Number.isInteger(v) && v >= 0 && v <= 100 && v !== value) onSave(v);
    else setDraft(String(value));
  };
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        min={0}
        max={100}
        value={draft}
        disabled={busy}
        className="h-11 w-16 px-2 font-mono text-base md:h-7 md:text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
