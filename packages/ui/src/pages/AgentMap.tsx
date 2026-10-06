// Bản đồ agent (roadmap 31b): each machine a column of its profiles, each profile with the runs it has now and what
// the agent is doing, the machine's queue under them, and the open batches on the right. Profiles picked here get one
// prompt (one agent, or a fan-out) or the tasks picked next on the Task page.
import { useState, type KeyboardEvent } from "react";
import { ListChecks, Sparkles } from "lucide-react";
import { cn } from "cn";
import type { Machine, QuotaCooldown, ReportedProfile, RunGroup, RunRecord, RunRequest } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Sheet } from "@xdev-hive/ui/components/ui/sheet";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { PromptSheet } from "#ui/components/AgentSheets.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useCan, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { usageAsOf } from "#ui/lib/agents.ts";
import { encodeTargets, machineCards, type AgentTarget, type ProfileCard, type ProfileState } from "#ui/lib/agentmap.ts";
import { shortAgo } from "#ui/lib/inbox.ts";
import { scopeProject } from "#ui/lib/scope.ts";

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
const takesWork = (m: Machine, c: ProfileCard) => m.online && m.acceptsRuns && !["off", "noCli", "signedOut"].includes(c.state);

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
  const { scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const now = Date.now();
  // A prompt makes a task and queues its run; giving tasks queues runs: whoever may, on some project of the machine.
  const prompters = (scope.kind === "system" ? scope.projects : projects).filter((p) => allow(p, "taskManage") && allow(p, "runDispatch"));
  const dispatchers = projects.filter((p) => allow(p, "runDispatch"));
  const [picks, setPicks] = useState<AgentTarget[]>([]);
  const [prompting, setPrompting] = useState(false);
  const picked = (x: AgentTarget) => picks.some((p) => targetKey(p) === targetKey(x));
  const toggle = (x: AgentTarget) => setPicks((all) => (picked(x) ? all.filter((p) => targetKey(p) !== targetKey(x)) : [...all, x]));
  const activity = new Map(runs.map((r) => [`${r.machineId}/${r.runId}`, r.activity]));
  const open = groups.filter((g) => !g.closedAt);
  const scoped = scopeProject(scope);
  // The prompt's project: one every picked machine has a repo of, so each picked agent can take it.
  const shared = prompters.filter((p) => picks.every((x) => machines.find((m) => m.id === x.machineId)?.projects.includes(p)));
  const promptProject = scoped && shared.includes(scoped) ? scoped : (shared[0] ?? prompters[0]);

  return (
    <div className="flex flex-col gap-3">
      {picks.length ? (
        <div role="toolbar" aria-label={t("agentMap.picked", { count: picks.length })} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-inverse px-3 py-2 text-[13px] text-fg-inverse">
          <span className="font-semibold">{t("agentMap.picked", { count: picks.length })}</span>
          <span className="flex-1" />
          {prompters.length ? (
            <button type="button" onClick={() => setPrompting(true)} data-map-prompt className="inline-flex h-10 md:h-7 cursor-pointer items-center gap-1.5 rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring">
              <Sparkles className="size-3.5" />
              {picks.length > 1 ? t("agentMap.promptMany", { count: picks.length }) : t("agentMap.promptOne")}
            </button>
          ) : null}
          <a href={`#/tasks?agents=${encodeURIComponent(encodeTargets(picks))}`} data-map-batch className="inline-flex h-10 md:h-7 items-center gap-1.5 rounded-sm border border-white/30 px-2.5 text-xs font-semibold outline-none hover:bg-white/10 focus-visible:focus-ring">
            <ListChecks className="size-3.5" />
            {t("agentMap.giveTasks", { count: picks.length })}
          </a>
          <button type="button" onClick={() => setPicks([])} className="h-10 md:h-7 cursor-pointer rounded-sm px-2 text-xs underline">
            {t("agentMap.clear")}
          </button>
        </div>
      ) : null}
      <div className="flex flex-col items-stretch gap-3 pb-2 md:flex-row md:items-start md:overflow-x-auto">
        {machines.map((m) => (
          <MachineColumn
            key={m.id}
            machine={m}
            cooldowns={cooldowns}
            activity={activity}
            queued={requests.filter((r) => r.machineId === m.id && r.status === "pending")}
            now={now}
            canPick={m.projects.some((p) => dispatchers.includes(p))}
            picked={picked}
            onToggle={toggle}
            onChanged={onChanged}
          />
        ))}
        <section className="flex w-full shrink-0 md:w-[280px] flex-col gap-2 rounded-xl border border-line-default bg-sunken p-2.5" aria-label={t("agentMap.batches")}>
          <h3 className="m-0 px-1 text-[13px]/5 font-semibold text-fg-strong">{t("agentMap.batches")}</h3>
          {open.length === 0 ? <p className="m-0 px-1 text-xs text-fg-muted">{t("agentMap.batchesNone")}</p> : null}
          {open.map((g) => {
            const held = g.items.filter((i) => i.status === "held");
            return (
              <a key={g.id} href={`#/batches?group=${g.id}`} className="flex flex-col gap-1 rounded-lg border border-line-default bg-surface p-2.5 outline-none hover:border-fg-secondary focus-visible:focus-ring">
                <span className="truncate text-[13px] font-medium text-fg-strong">{g.title || t("agentMap.batchTitle", { id: g.id })}</span>
                <span className="text-xs text-fg-muted">
                  <span className="font-mono">{g.project}</span> · {t("agentMap.batchProgress", { active: g.items.filter((i) => i.active).length, held: held.length, total: g.items.length })}
                </span>
                {held.some((i) => !i.machineId) ? <span className="text-xs text-fg-muted">{t("agentMap.batchAnyMachine", { count: held.filter((i) => !i.machineId).length })}</span> : null}
              </a>
            );
          })}
        </section>
      </div>
      <Sheet open={prompting} onOpenChange={setPrompting}>
        {prompting && promptProject ? (
          <PromptSheet
            projects={prompters}
            defaultProject={promptProject}
            initialTargets={picks}
            onSent={(task) => {
              setPrompting(false);
              setPicks([]);
              window.location.hash = `#/tasks?task=${encodeURIComponent(task.id)}`;
            }}
            onGroup={(id) => {
              setPrompting(false);
              setPicks([]);
              window.location.hash = `#/batches?group=${id}`;
            }}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

function MachineColumn({
  machine: m,
  cooldowns,
  activity,
  queued,
  now,
  canPick,
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
  picked: (x: AgentTarget) => boolean;
  onToggle: (x: AgentTarget) => void;
  onChanged: () => void;
}) {
  const { client, me } = useHive();
  const t = useT();
  const action = useAction();
  const { cards, queue } = machineCards(m, cooldowns, now);
  return (
    <section className={cn("flex w-full shrink-0 md:w-[300px] flex-col gap-2 rounded-xl border border-line-default bg-sunken p-2.5", !m.online && "opacity-75")} aria-label={m.machine} data-map-machine={m.machine}>
      <div className="flex flex-col gap-0.5 px-1">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", m.duplicate ? "bg-danger-solid" : m.online ? "bg-success-solid" : "bg-neutral-solid")} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-fg-strong">{m.machine}</span>
          {m.version ? <span className="font-mono text-[11px] text-fg-muted">v{m.version}</span> : null}
        </div>
        <span className="text-xs text-fg-muted">
          {m.duplicate ? t("machineState.duplicate") : m.online ? t("machineState.online") : t("machines.lastSeen", { time: formatTime(m.lastSeen) })}
          {" · "}
          {m.acceptsRuns ? t("machines.acceptsRuns") : t("agentMap.notAccepting")}
        </span>
      </div>
      {cards.length === 0 ? <p className="m-0 px-1 text-xs text-fg-muted">{t("agentMap.noProfiles")}</p> : null}
      {cards.map((c) => {
        const target = { machineId: m.id, profileId: c.profile.id };
        return (
          <ProfileCardView
            key={c.profile.id}
            card={c}
            machine={m}
            activity={activity}
            now={now}
            pick={canPick && takesWork(m, c) ? { on: picked(target), toggle: () => onToggle(target) } : null}
          />
        );
      })}
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
      {mayManage(me, m) && m.profiles.length ? (
        <details className="px-1 text-xs">
          <summary className="cursor-pointer text-fg-muted select-none">{t("agentMap.manage")}</summary>
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
      <ErrorNote error={action.error} />
    </section>
  );
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
      <span className="truncate font-mono text-[11px] text-fg-muted">
        {p.id} · {p.kind}
        {p.account ? ` · ${p.account}` : ""}
      </span>
      {/* A change asked on the web shows on the card until the machine reports it, the manage section closed or not. */}
      {waiting ? <span className="text-[11px] text-warning">{t("machines.profileWaiting", { who: waiting.requestedBy, time: formatTime(waiting.requestedAt) })}</span> : null}
      {p.sessionPercent != null || p.weekPercent != null ? (
        <div className="grid grid-cols-[44px_1fr_32px] items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
          <Quota label={t("ops.session")} percent={p.sessionPercent} />
          <Quota label={t("ops.week")} percent={p.weekPercent} />
        </div>
      ) : null}
      {p.sessionResets || p.weekResets || usageAsOf(p.usageCheckedAt) ? (
        <span data-usage-resets className="text-[11px]/4 text-fg-muted">
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
              <span className="shrink-0 text-[11px] text-fg-muted">{shortAgo(r.since, now, t)}</span>
            </span>
            {doing ? <span className="line-clamp-2 text-[11px]/4 text-fg-muted">{doing}</span> : null}
          </a>
        );
      })}
    </div>
  );
}

function Quota({ label, percent }: { label: string; percent: number | null | undefined }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <>
      <span>{label}</span>
      <span className="relative h-1.5 overflow-hidden rounded-full bg-sunken">
        {percent != null ? <span className={cn("absolute inset-y-0 left-0 rounded-full", pct >= 80 ? "bg-warning-solid" : "bg-primary")} style={{ width: `${pct}%` }} /> : null}
      </span>
      <span className="text-right font-mono">{percent != null ? `${Math.round(pct)}%` : "—"}</span>
    </>
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
        className="h-7 w-16 px-2 font-mono text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
