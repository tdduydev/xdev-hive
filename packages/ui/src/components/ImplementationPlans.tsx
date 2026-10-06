import { Input } from "@xdev-hive/ui/components/ui/input";
import { useState } from "react";
import type { ImplementationPlan, PlanApprovalMode } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function PlanCard({ plan, onChanged }: { plan: ImplementationPlan; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const [note, setNote] = useState("");
  const editable = plan.status === "waiting" && can(plan.project, "runDispatch");
  const decide = (decision: "approve" | "changes" | "cancel") => void action.run(async () => {
    await client.call("runs.decidePlan", { id: plan.id, revision: plan.revision, decision, note });
    setNote(""); onChanged();
  });
  return <section className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3" data-implementation-plan={plan.id}>
    <p className="text-sm font-semibold">{t("planApproval.revision", { n: plan.revision })} · {t(`planApproval.state.${plan.status}`)}</p>
    {plan.deadline && plan.status === "waiting" ? <p className="text-xs text-muted-foreground">{t("planApproval.deadline", { time: formatTime(plan.deadline) })}</p> : null}
    {plan.text ? <div className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere" data-plan-text>{plan.text}</div> : null}
    {plan.note ? <p className="text-sm whitespace-pre-wrap wrap-anywhere">{plan.note}</p> : null}
    {editable ? <><label className="block space-y-1 text-sm"><span>{t("planApproval.note")}</span><Textarea className="text-base" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-plan-note /></label>
      <div className="flex flex-wrap gap-2"><Button className="min-h-(--control-h-touch)" disabled={action.busy} onClick={() => decide("approve")} data-plan-approve>{t("planApproval.approve")}</Button><Button className="min-h-(--control-h-touch)" variant="outline" disabled={action.busy || !note.trim()} onClick={() => decide("changes")} data-plan-changes>{t("planApproval.changes")}</Button><Button className="min-h-(--control-h-touch)" variant="ghost" disabled={action.busy} onClick={() => decide("cancel")} data-plan-cancel>{t("planApproval.cancel")}</Button></div></> : null}
    <ErrorNote error={action.error} />
  </section>;
}

export function ImplementationPlans({ project, taskId }: { project: string; taskId: string }) {
  const { client, bump } = useHive();
  const poll = usePoll(15000);
  const [tick, setTick] = useState(0);
  const t = useT();
  const plans = useQuery(() => client.call("runs.plans", { project, taskId }), [client, project, taskId, poll, tick]);
  return <div className="space-y-3"><ErrorNote error={plans.error} />{plans.loading && !plans.data ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p> : null}{plans.data?.length === 0 ? <p className="text-sm text-muted-foreground">{t("planApproval.empty")}</p> : null}{plans.data?.filter((p) => p.project === project && p.taskId === taskId).map((p) => <PlanCard key={p.id} plan={p} onChanged={() => { setTick((n) => n + 1); bump(); }} />)}</div>;
}


export function PlanApprovalFields({ mode, onMode, timeout, onTimeout, disabled }: {
  mode: PlanApprovalMode; onMode: (mode: PlanApprovalMode) => void;
  timeout: string; onTimeout: (timeout: string) => void; disabled: boolean;
}) {
  const t = useT();
  return <fieldset className="space-y-3" data-plan-settings><legend className="text-sm font-semibold">{t("planApproval.title")}</legend><p className="text-sm text-muted-foreground">{t("planApproval.intro")}</p><div className="space-y-2">{(["off", "medium-large", "all"] as const).map((choice) => <button key={choice} className={`min-h-(--control-h-touch) w-full rounded-lg border p-3 text-left text-sm outline-none focus-visible:focus-ring hover:bg-hover disabled:opacity-50 ${mode === choice ? "border-primary bg-selected" : "border-border"}`} aria-pressed={mode === choice} disabled={disabled} onClick={() => onMode(choice)} data-plan-mode={choice}>{t(`planApproval.mode.${choice}`)}</button>)}</div><label className="block text-sm">{t("planApproval.timeout")}<Input className="mt-1 min-h-(--control-h-touch) text-base" type="number" min={1} max={10080} value={timeout} onChange={(e) => onTimeout(e.target.value)} disabled={disabled} aria-describedby="plan-timeout-hint" data-plan-timeout /></label><p id="plan-timeout-hint" className="text-xs text-muted-foreground">{t("planApproval.timeoutHint")}</p></fieldset>;
}
