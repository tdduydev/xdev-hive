import { useEffect, useId, useState } from "react";
import type { Machine, ReportedProfile, Task } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { agentLabel, assignableMachines, assignmentInput, assignInOrder } from "#ui/lib/assignment.ts";
import { requestErrorText } from "#ui/lib/runs.ts";

export const assignmentControl = "w-full max-md:min-h-11 max-md:text-base";

/** Native selects also provide the keyboard and touch alternative to dragging on the board. */
export function AgentAssignment({ tasks, onChanged, onAssigned }: { tasks: Task[]; onChanged: () => void; onAssigned?: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const id = useId();
  const poll = usePoll(5000);
  const single = tasks.length === 1 ? tasks[0] : undefined;
  const current = single?.agent;
  const [machineId, setMachine] = useState(current?.machineId ?? "");
  const [profileId, setProfile] = useState(current?.profileId ?? "");
  const [before, setBefore] = useState("");
  useEffect(() => { setMachine(current?.machineId ?? ""); setProfile(current?.profileId ?? ""); setBefore(""); }, [single?.id, current?.machineId, current?.profileId]);
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  const requests = useQuery(() => client.call("runs.requests", { limit: 200 }), [client, poll, tasks]);
  const counts = useQuery(() => client.call("tasks.list", {}), [client, poll, tasks]);
  const queue = useQuery(async () => machineId ? client.call("tasks.agentQueue", { machineId }) : [], [client, machineId, poll, tasks]);
  const fit = assignableMachines(machines.data ?? [], tasks.map((task) => task.project));
  const machine = fit.find((m) => m.id === machineId);
  const can = tasks.length > 0 && tasks.every((task) => allow(task.project, "runDispatch"));
  const editable = can && tasks.every((task) => task.status !== "done");
  const rows = queue.data ?? [];
  const position = rows.findIndex((r) => r.task.id === single?.id);
  const waiting = current?.hold ?? (current?.machineId === machineId ? rows[position]?.waiting : null);
  const count = (m: Machine, p?: ReportedProfile) => (counts.data ?? []).filter((task) => task.status !== "done" && task.agent?.machineId === m.id && (!p || task.agent.profileId === p.id)).length;
  const detail = (m: Machine, p?: ReportedProfile) => {
    const profiles = p ? [p] : m.profiles.filter((p) => p.enabled);
    const running = m.runs.filter((r) => r.status === "running" && (!p || r.profileId === p.id)).length;
    const pending = (requests.data ?? []).filter((r) => r.machineId === m.id && r.status === "pending" && (!p || !r.profileId || r.profileId === p.id)).length;
    const max = profiles.reduce((n, p) => n + (p.maxConcurrent ?? 1), 0);
    const pct = (key: "sessionPercent" | "weekPercent") => {
      const values = profiles.map((p) => p[key]).filter((v): v is number => v != null);
      return values.length ? `${Math.round(Math.max(...values))}%` : "—";
    };
    return `${t(!m.online ? "assignment.offline" : running + pending >= max ? "assignment.busy" : "assignment.free")} · ${t("assignment.quota", { session: pct("sessionPercent"), week: pct("weekPercent") })} · ${t("assignment.queued", { n: count(m, p) })}`;
  };
  const refresh = () => { queue.reload(); counts.reload(); onChanged(); bump(); };
  const assign = () => void action.run(async () => {
    if (!machine || !editable) return;
    // Sequential calls preserve the user's selection order; refresh successes even if a later task is rejected.
    try {
      await assignInOrder(tasks, { machineId, profileId: profileId || null }, before || undefined, (input) => client.call("tasks.assign", input));
      onAssigned?.();
    }
    finally { refresh(); }
  });
  return <section data-agent-assignment className="flex min-w-0 flex-col gap-3 rounded-lg border border-line-default p-3">
    <h3 className="text-sm font-semibold">{t("assignment.title")}</h3>
    <p className="text-xs text-fg-secondary">{t("assignment.hint")}</p>
    {current ? <div className="flex flex-col gap-1 text-xs wrap-anywhere" aria-live="polite">
      <span>{agentLabel(current, t("assignment.any"))}</span>
      {current.machineId === machineId && position >= 0 ? <span data-agent-position>{t("assignment.position", { n: position + 1 })}</span> : null}
      <span data-agent-waiting>{waiting ? requestErrorText(waiting) : t("assignment.waiting")}</span>
    </div> : null}
    {editable ? <>
      <label htmlFor={`${id}-machine`} className="text-xs font-medium">{t("assignment.machine")}</label>
      <NativeSelect id={`${id}-machine`} data-assign-machine wrapperClassName="w-full min-w-0" className={assignmentControl} value={machineId} onChange={(e) => { setMachine(e.target.value); setProfile(""); setBefore(""); }} disabled={action.busy}>
        <NativeSelectOption value="">{t("assignment.choose")}</NativeSelectOption>
        {fit.map((m) => <NativeSelectOption key={m.id} value={m.id}>{m.machine} · {detail(m)}</NativeSelectOption>)}
      </NativeSelect>
      {machine ? <>
        <label htmlFor={`${id}-profile`} className="text-xs font-medium">{t("assignment.profile")}</label>
        <NativeSelect id={`${id}-profile`} data-assign-profile wrapperClassName="w-full min-w-0" className={assignmentControl} value={profileId} onChange={(e) => setProfile(e.target.value)} disabled={action.busy}>
          <NativeSelectOption value="">{t("assignment.any")} · {detail(machine)}</NativeSelectOption>
          {machine.profiles.filter((p) => p.enabled).map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label} · {detail(machine, p)}</NativeSelectOption>)}
        </NativeSelect>
        <p className="text-xs wrap-anywhere text-fg-secondary">{detail(machine, machine.profiles.find((p) => p.id === profileId))}</p>
        <label htmlFor={`${id}-before`} className="text-xs font-medium">{t("assignment.before")}</label>
        <NativeSelect id={`${id}-before`} data-assign-before wrapperClassName="w-full min-w-0" className={assignmentControl} value={before} onChange={(e) => setBefore(e.target.value)} disabled={action.busy || queue.loading}>
          <NativeSelectOption value="">{t("assignment.last")}</NativeSelectOption>
          {rows.filter((r) => !tasks.some((task) => task.id === r.task.id) && r.task.status !== "done").map(({ task }) => <NativeSelectOption key={task.id} value={task.id}>{task.id} · {task.title}</NativeSelectOption>)}
        </NativeSelect>
      </> : null}
      {!machines.loading && !fit.length ? <p className="text-xs">{t("assignment.noMachines")}</p> : null}
      <Button data-assign-save className="max-md:min-h-11" disabled={!machine || action.busy || !!profileId && !machine.profiles.some((p) => p.id === profileId && p.enabled)} onClick={assign}>{t("assignment.assign")}</Button>
    </> : null}
    {current && can ? <div className="flex flex-wrap gap-2">
      {current.hold && editable ? <Button variant="outline" className="max-md:min-h-11" disabled={action.busy} onClick={() => void action.run(async () => { await client.call("tasks.assign", assignmentInput(single!.id, current)); refresh(); })}>{t("assignment.retry")}</Button> : null}
      <Button data-assign-remove variant="outline" className="max-md:min-h-11" disabled={action.busy} onClick={() => void action.run(async () => { await client.call("tasks.unassign", { id: single!.id }); refresh(); })}>{t("assignment.remove")}</Button>
    </div> : null}
    {!can ? <p className="text-xs text-fg-secondary">{t("assignment.noRight")}</p> : null}
    <ErrorNote error={action.error ?? machines.error ?? queue.error ?? counts.error ?? requests.error} />
  </section>;
}

export function AssignedQueue({ machineId, profileId }: { machineId: string; profileId: string | null }) {
  const { client, bump } = useHive();
  const allow = useCan();
  const t = useT();
  const action = useAction();
  const poll = usePoll(5000);
  const [all, setAll] = useState(false);
  const queue = useQuery(() => client.call("tasks.agentQueue", { machineId, profileId }), [client, machineId, profileId, poll]);
  // A null API filter means every profile; the rotating lane must not duplicate pinned tasks.
  const rows = (queue.data ?? []).filter((r) => r.task.agent?.profileId === profileId && r.task.status !== "done");
  return <section data-assigned-queue className="flex min-w-0 flex-col gap-2 rounded-md border border-line-default bg-surface p-2 text-xs">
    <h4 className="font-semibold">{profileId ?? t("assignment.any")} · {t("assignment.queue")} ({rows.length})</h4>
    {(all ? rows : rows.slice(0, 3)).map(({ task, waiting }) => <div key={task.id} className="flex min-w-0 flex-col gap-1">
      <a className="flex min-h-11 items-center wrap-anywhere underline focus-visible:focus-ring md:min-h-0" href={`#/tasks?task=${encodeURIComponent(task.id)}`}>{task.id} · {task.title}</a>
      {waiting ? <span className="wrap-anywhere text-fg-secondary">{requestErrorText(waiting)}</span> : null}
      {allow(task.project, "runDispatch") ? <NativeSelect aria-label={`${t("assignment.before")} · ${task.id}`} wrapperClassName="w-full min-w-0" className={assignmentControl} value="" disabled={action.busy} onChange={(e) => void action.run(async () => {
        await client.call("tasks.assign", assignmentInput(task.id, { machineId, profileId }, e.target.value)); queue.reload(); bump();
      })}>
        <NativeSelectOption value="" disabled>{t("assignment.before")}</NativeSelectOption>
        {rows.filter((r) => r.task.id !== task.id).map((r) => <NativeSelectOption key={r.task.id} value={r.task.id}>{r.task.id}</NativeSelectOption>)}
      </NativeSelect> : null}
    </div>)}
    {rows.length > 3 ? <Button variant="ghost" className="max-md:min-h-11" onClick={() => setAll(!all)}>{all ? t("common.showLess") : t("assignment.allQueue", { n: rows.length })}</Button> : null}
    <ErrorNote error={action.error ?? queue.error} />
  </section>;
}
