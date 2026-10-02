// A Spec Kit flow the hub drives through the project's gates (roadmap 34b): where it is, the gate it waits at with
// what the AI check said, and a person's word there (pass, or the step again with what to change).
import { useEffect, useState } from "react";
import { FLOW_STEPS, type SdlcFlow, type SdlcFlowTask, type SdlcGateRecord, type TaskStage } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

const STATE_CHIP: Record<SdlcFlow["state"], ChipKind> = {
  running: "running",
  check: "info",
  checking: "info",
  gate: "warning",
  next: "info",
  stopped: "danger",
  done: "success",
};
/** States that change by themselves, so the card looks again. */
const MOVING = new Set<SdlcFlow["state"]>(["running", "check", "checking", "next"]);

/** The flows of a project (all, or the one of a task), newest first; nothing when there is none. */
export function FlowList({ project, taskId, openOnly = false }: { project: string; taskId?: string; openOnly?: boolean }) {
  const { client } = useHive();
  const [moving, setMoving] = useState(false);
  const poll = usePoll(moving ? 5000 : null);
  const flows = useQuery(() => client.call("sdlc.flows", { project }), [client, project, poll]);
  const shown = (flows.data ?? []).filter((f) => (!taskId || f.taskId === taskId) && (!openOnly || f.state !== "done"));
  useEffect(() => setMoving(shown.some((f) => MOVING.has(f.state))), [shown]);
  if (!shown.length) return <ErrorNote error={flows.error} />;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((f) => (
        <FlowCard key={f.taskId} flow={f} onChanged={flows.reload} />
      ))}
    </div>
  );
}

function FlowCard({ flow: f, onChanged }: { flow: SdlcFlow; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const [note, setNote] = useState("");
  const gates = useQuery(() => client.call("sdlc.gates", { project: f.project, taskId: f.taskId, limit: 20 }), [client, f.taskId, f.updatedAt]);
  const deciding = f.state === "gate" && f.gate && (f.gate.status === "waiting" || f.gate.status === "escalated");
  const canDecide = allow(f.project, "runDispatch") && (f.gate?.gate !== "tasks" || allow(f.project, "taskManage"));
  const decide = (decision: "pass" | "changes") =>
    void action.run(async () => {
      await client.call("sdlc.decide", { gateId: f.gate!.id, decision, note });
      setNote("");
      onChanged();
    });
  const at = FLOW_STEPS.indexOf(f.step);
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line-default bg-surface p-3" data-flow={f.taskId} data-flow-state={f.state}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[13px] font-semibold text-fg-strong">{t("flow.title", { task: f.taskId })}</b>
        <Chip kind={STATE_CHIP[f.state]} small>
          {t(`flow.state.${f.state}`, { step: t(`flow.step.${f.step}`), gate: f.gate ? t(`sdlc.gate.${f.gate.gate}`) : "" })}
        </Chip>
        <span className="ml-auto font-mono text-xs text-fg-muted">
          {f.machine}
          {f.dir ? ` · specs/${f.dir}` : ""}
        </span>
      </div>
      <ol className="m-0 flex list-none flex-wrap gap-1 p-0 text-xs">
        {FLOW_STEPS.map((s, i) => (
          <li key={s} className={i < at || f.state === "done" ? "text-success" : i === at ? "font-semibold text-fg-strong" : "text-fg-muted"}>
            {i ? "→ " : ""}
            {t(`flow.step.${s}`)}
          </li>
        ))}
      </ol>
      {f.note && f.state !== "gate" ? <p className="m-0 text-xs wrap-anywhere text-fg-muted">{f.note}</p> : null}
      {deciding && f.gate ? (
        <div className="flex flex-col gap-2 rounded-md bg-sunken p-2">
          <span className="text-xs font-medium text-fg-strong">
            {t(f.gate.status === "escalated" ? "flow.escalated" : "flow.waiting", { gate: t(`sdlc.gate.${f.gate.gate}`), mode: t(`sdlc.mode.${f.gate.mode}`) })}
          </span>
          {f.gate.note ? <pre className="m-0 max-h-48 overflow-auto rounded border border-line-subtle bg-code p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{f.gate.note}</pre> : null}
          {canDecide ? (
            <>
              <Textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={t("flow.notePlaceholder")} aria-label={t("flow.note")} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={action.busy} onClick={() => decide("pass")} data-gate-pass={f.gate.id}>
                  {t(`flow.pass.${f.gate.gate === "tasks" ? "tasks" : f.gate.gate === "dispatch" ? "dispatch" : "next"}`)}
                </Button>
                <Button size="sm" variant="outline" disabled={action.busy || !note.trim()} onClick={() => decide("changes")} data-gate-changes={f.gate.id}>
                  {t("flow.changes")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {f.state === "stopped" && allow(f.project, "runDispatch") ? (
        <div>
          <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => (await client.call("sdlc.retry", { taskId: f.taskId }), onChanged()))}>
            {t("flow.retry", { step: t(`flow.step.${f.step}`) })}
          </Button>
        </div>
      ) : null}
      {at >= FLOW_STEPS.indexOf("import") || f.state === "done" ? <FlowTasks project={f.project} flowTask={f.taskId} /> : null}
      {gates.data?.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted select-none">{t("flow.history", { count: gates.data.length })}</summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {gates.data.map((g) => (
              <GateLine key={g.id} gate={g} />
            ))}
          </ul>
        </details>
      ) : null}
      <ErrorNote error={action.error} />
    </section>
  );
}

function GateLine({ gate: g }: { gate: SdlcGateRecord }) {
  const t = useT();
  return (
    <li className="flex flex-wrap gap-x-2 text-fg-muted">
      <span className="font-medium text-fg-strong">{t(`sdlc.gate.${g.gate}`)}</span>
      <span>{t(`sdlc.mode.${g.mode}`)}</span>
      <span>{t(`flow.gateStatus.${g.status}`)}</span>
      {g.decidedBy ? <span className="font-mono">{g.decidedBy}</span> : null}
      <span>{formatTime(g.decidedAt ?? g.createdAt)}</span>
    </li>
  );
}

const STAGE_CHIP: Record<TaskStage, ChipKind> = {
  queued: "neutral",
  build: "running",
  review: "info",
  fixnext: "info",
  fix: "running",
  check: "info",
  checking: "info",
  gate: "warning",
  merge: "info",
  merging: "running",
  done: "success",
  stopped: "danger",
};

/** The tasks a flow gave to agents (34c), each with where it is on its way to main. */
function FlowTasks({ project, flowTask }: { project: string; flowTask: string }) {
  const { client } = useHive();
  const t = useT();
  const tasks = useQuery(() => client.call("sdlc.flowTasks", { project, flowTask }), [client, flowTask]);
  if (!tasks.data?.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs" data-flow-tasks={flowTask}>
      {tasks.data.map((x) => (
        <li key={x.taskId} className="flex flex-wrap items-center gap-2">
          <a className="font-mono hover:underline" href={`#/tasks?task=${encodeURIComponent(x.taskId)}`}>
            {x.taskId}
          </a>
          <Chip kind={STAGE_CHIP[x.stage]} small>
            {t(`flow.stage.${x.stage}`, { gate: x.gate ? t(`sdlc.gate.${x.gate.gate}`) : "" })}
          </Chip>
          {x.fixRounds ? <span className="text-fg-muted">{t("flow.fixRounds", { count: x.fixRounds })}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A task a flow gave to agents (34c, 34d), in its panel: where it is, and the gate it waits at for a person. */
export function FlowTaskPanel({ project, taskId }: { project: string; taskId: string }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const [note, setNote] = useState("");
  const [moving, setMoving] = useState(false);
  const poll = usePoll(moving ? 5000 : null);
  const rows = useQuery(() => client.call("sdlc.flowTasks", { project, taskId }), [client, taskId, poll]);
  const x: SdlcFlowTask | undefined = rows.data?.[0];
  useEffect(() => setMoving(!!x && !["gate", "done", "stopped"].includes(x.stage)), [x]);
  if (!x) return null;
  const gate = x.stage === "gate" && x.gate && (x.gate.status === "waiting" || x.gate.status === "escalated") ? x.gate : null;
  const may = gate ? allow(project, gate.gate === "review" || gate.gate === "merge" ? "codeReview" : "runDispatch") : false;
  const decide = (decision: "pass" | "changes") =>
    void action.run(async () => {
      await client.call("sdlc.decide", { gateId: gate!.id, decision, note });
      setNote("");
      rows.reload();
    });
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line-default bg-surface p-3" data-flow-task={x.taskId} data-flow-task-stage={x.stage}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[13px] font-semibold text-fg-strong">{t("flow.taskTitle", { flow: x.flowTask })}</b>
        <Chip kind={STAGE_CHIP[x.stage]} small>
          {t(`flow.stage.${x.stage}`, { gate: x.gate ? t(`sdlc.gate.${x.gate.gate}`) : "" })}
        </Chip>
        {x.fixRounds ? <span className="text-xs text-fg-muted">{t("flow.fixRounds", { count: x.fixRounds })}</span> : null}
      </div>
      {x.note && !gate && x.stage === "stopped" ? <p className="m-0 text-xs wrap-anywhere text-fg-muted">{x.note}</p> : null}
      {gate ? (
        <div className="flex flex-col gap-2 rounded-md bg-sunken p-2">
          <span className="text-xs font-medium text-fg-strong">
            {t(gate.status === "escalated" ? "flow.escalated" : "flow.waiting", { gate: t(`sdlc.gate.${gate.gate}`), mode: t(`sdlc.mode.${gate.mode}`) })}
          </span>
          {gate.note || x.note ? (
            <pre className="m-0 max-h-48 overflow-auto rounded border border-line-subtle bg-code p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{gate.note ?? x.note}</pre>
          ) : null}
          {may ? (
            <>
              <Textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={t(gate.gate === "review" ? "flow.taskNoteReview" : "flow.taskNoteOther")} aria-label={t("flow.note")} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={action.busy} onClick={() => decide("pass")} data-task-gate-pass={gate.id}>
                  {t(`flow.taskPass.${gate.gate === "fix" ? "fix" : gate.gate === "merge" ? "merge" : "review"}`)}
                </Button>
                <Button size="sm" variant="outline" disabled={action.busy || (gate.gate === "review" && !note.trim())} onClick={() => decide("changes")}>
                  {t(`flow.taskChanges.${gate.gate === "fix" ? "fix" : gate.gate === "merge" ? "merge" : "review"}`)}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={action.error ?? rows.error} />
    </section>
  );
}
