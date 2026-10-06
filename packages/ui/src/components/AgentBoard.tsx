import { useEffect, useState } from "react";
import type { Machine, Task } from "@xdev-hive/core";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { assignmentControl } from "#ui/components/AgentAssignment.tsx";
import { useAction, useCan, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { agentKey, agentLanes, agentTasks, assignableMachines, assignmentInput, type AssignmentTarget } from "#ui/lib/assignment.ts";

export function AgentBoard({ tasks, machines, onOpen, onChanged }: { tasks: Task[]; machines: Machine[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [drag, setDrag] = useState<Task | null>(null);
  const lanes = agentLanes(machines, tasks, t("assignment.any"), t("assignment.unassigned"));
  const canMove = (task: Task) => task.status !== "done" && allow(task.project, "runDispatch");
  const move = (task: Task, target: AssignmentTarget | null, before?: string) => {
    if (!canMove(task) || action.busy || task.id === before) return;
    void action.run(async () => {
      if (target) await client.call("tasks.assign", assignmentInput(task.id, target, before));
      else await client.call("tasks.unassign", { id: task.id });
      onChanged(); bump();
    });
  };
  return <div className="flex min-w-0 flex-col gap-2">
    <ErrorNote error={action.error} />
    <div data-agent-board className="flex min-w-0 flex-col gap-3 md:flex-row md:overflow-x-auto">
      {lanes.map((lane) => <section key={lane.key} data-agent-lane={lane.key} aria-label={lane.label} className="flex w-full shrink-0 flex-col gap-2 rounded-lg border border-line-default bg-sunken p-3 md:w-72"
        onDragOver={(e) => { if (!mobile && drag && !action.busy) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (!mobile && drag) move(drag, lane.target); setDrag(null); }}>
        <h3 className="text-sm font-semibold wrap-anywhere">{lane.label} ({agentTasks(tasks, lane.key).length})</h3>
        {!agentTasks(tasks, lane.key).length ? <p className="text-xs text-fg-secondary">{t("assignment.empty")}</p> : null}
        {agentTasks(tasks, lane.key).map((task) => {
          const fit = new Set(assignableMachines(machines, [task.project]).map((m) => m.id));
          const choices = lanes.filter((l) => !l.target || fit.has(l.target.machineId) && (!l.target.profileId || machines.find((m) => m.id === l.target!.machineId)?.profiles.some((p) => p.id === l.target!.profileId && p.enabled)));
          return <article key={task.id} data-agent-task={task.id} draggable={!mobile && canMove(task) && !action.busy}
            onDragStart={(e) => { e.dataTransfer.setData("text/plain", task.id); e.dataTransfer.effectAllowed = "move"; setDrag(task); }} onDragEnd={() => setDrag(null)}
            onDragOver={(e) => { if (!mobile && drag) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!mobile && drag) move(drag, lane.target, task.id); setDrag(null); }}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-line-default bg-surface p-3">
            <button className="min-h-11 text-left text-sm wrap-anywhere outline-none focus-visible:focus-ring" onClick={() => onOpen(task.id)}>{task.id} · {task.title}</button>
            <span className="text-xs text-fg-secondary">{t(`taskStatus.${task.status}`)}</span>
            {canMove(task) ? <>
              <label className="flex min-w-0 flex-col gap-1 text-xs">{t("assignment.title")}
                <NativeSelect data-agent-card-select wrapperClassName="w-full min-w-0" className={assignmentControl} aria-label={`${t("assignment.title")} · ${task.id}`} value={agentKey(task.agent)} disabled={action.busy} onChange={(e) => { const target = choices.find((l) => l.key === e.target.value); if (target) move(task, target.target); }}>
                  {choices.map((l) => <NativeSelectOption key={l.key} value={l.key}>{l.label}</NativeSelectOption>)}
                  {!choices.some((l) => l.key === agentKey(task.agent)) ? <NativeSelectOption value={agentKey(task.agent)} disabled>{lane.label}</NativeSelectOption> : null}
                </NativeSelect>
              </label>
              {lane.target ? <label className="flex min-w-0 flex-col gap-1 text-xs">{t("assignment.before")}
                <NativeSelect data-agent-card-before wrapperClassName="w-full min-w-0" className={assignmentControl} aria-label={`${t("assignment.before")} · ${task.id}`} value="" disabled={action.busy} onChange={(e) => move(task, lane.target, e.target.value)}>
                  <NativeSelectOption value="" disabled>{t("assignment.before")}</NativeSelectOption>
                            {agentTasks(tasks, lane.key).filter((x) => x.id !== task.id).map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.id} · {x.title}</NativeSelectOption>)}
                </NativeSelect>
              </label> : null}
            </> : null}
          </article>;
        })}
      </section>)}
    </div>
  </div>;
}
