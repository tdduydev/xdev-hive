// A Spec Kit flow the hub drives through the project's gates (roadmap 34b): where it is, the gate it waits at with
// what the AI check said, and a person's word there (pass, or the step again with what to change).
import { useEffect, useState } from "react";
import { FLOW_STEPS, type SdlcFlow, type SdlcGateRecord } from "@xdev-hive/core";
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
                  {t(`flow.pass.${f.gate.gate === "tasks" ? "tasks" : "next"}`)}
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
