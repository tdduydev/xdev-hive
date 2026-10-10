import { useId, useState } from "react";
import { DEFAULT_RUN_TIMEOUT, WORK_ROLES, runTimeoutMinutes, type RunRecord, type RunRequest, type WorkRole } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MachineSelect, ProfileSelect, takesRunsOf } from "#ui/components/MachinePicker.tsx";
import { formatTime, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { canRedispatch, runLabel, runLink, runOutcome } from "#ui/lib/runs.ts";

/** Shared by the run page and the task sheet, keeping a failed submission's draft available. */
export function RunRedispatch({ run, onSent, split = false }: { run: RunRecord; onSent: () => void; split?: boolean }) {
  const { client } = useHive();
  const allow = useCan();
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  // Split (the run drawer): "Chạy lại" and "Đổi gói" are one form opened from two buttons; the second one clears the profile.
  const [swap, setSwap] = useState(false);
  const full = useQuery(() => open ? client.call("runs.get", { machineId: run.machineId, runId: run.runId }) : Promise.resolve(null), [client, run.machineId, run.runId, open]);
  if (!canRedispatch(run) || !allow(run.project, "runDispatch")) return null;
  const toggle = (to: boolean) => { if (open && swap === to) setOpen(false); else { setSwap(to); setOpen(true); } };
  return <div className="flex w-full flex-col gap-3">
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant={split ? "default" : "outline"} className="w-fit max-md:min-h-11" data-run-redispatch aria-expanded={open && !swap} aria-controls={id} onClick={() => toggle(false)}>{t(split ? "runs.rerun" : "redispatch.title")}</Button>
      {split ? <Button size="sm" variant="outline" className="w-fit max-md:min-h-11" data-run-swap-profile aria-expanded={open && swap} aria-controls={id} onClick={() => toggle(true)}>{t("redispatch.swapProfile")}</Button> : null}
    </div>
    {open ? <div id={id}>
      <ErrorNote error={full.error} />
      {full.loading ? <p className="text-xs text-fg-muted" role="status">{t("common.loading")}</p> : full.data ? <RedispatchForm key={String(swap)} run={full.data} swap={swap} onSent={onSent} /> : !full.error ? <Notice tone="warn">{t("errors.runNotFound", { id: run.runId })}</Notice> : null}
    </div> : null}
  </div>;
}

function RedispatchForm({ run, swap, onSent }: { run: RunRecord; swap: boolean; onSent: () => void }) {
  const { client } = useHive();
  const t = useT();
  const id = useId();
  const action = useAction();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const timeoutSettings = useQuery(() => client.call("runs.timeoutSettings", {}), [client]);
  const tasks = useQuery(() => client.call("tasks.list", { project: run.project }), [client, run.project]);
  const fit = (machines.data ?? []).filter(m => takesRunsOf(m, run.project));
  const [machineId, setMachineId] = useState(run.machineId);
  const machine = fit.find(m => m.id === machineId) ?? null;
  const [profileId, setProfileId] = useState(swap ? "" : run.profileId ?? "");
  const [instructions, setInstructions] = useState(run.instructions ?? "");
  const [continueBranch, setContinueBranch] = useState(!!run.branch);
  const [reviewAfter, setReviewAfter] = useState(false);
  const [timeout, setTimeout] = useState("");
  const [sent, setSent] = useState<RunRequest | null>(null);
  const selectedProfile = machine?.profiles.some(p => p.enabled && p.id === profileId) ? profileId : "";
  const settings = timeoutSettings.data ?? DEFAULT_RUN_TIMEOUT;
  const profiles = (machine ? [machine] : fit).flatMap(m => m.profiles).filter(p => p.enabled && p.installed && (!selectedProfile || p.id === selectedProfile));
  const ceiling = Math.min(settings.maxMinutes, profiles.length ? Math.max(...profiles.map(p => p.timeoutMinutes ?? 60)) : 60);
  const task = tasks.data?.find(task => task.id === run.taskId);
  const automaticTimes = new Set(profiles.map(p => runTimeoutMinutes(settings, p.timeoutMinutes ?? 60, task?.kind ?? null, run.taskId)));
  const defaultMinutes = automaticTimes.size === 1 ? [...automaticTimes][0]! : null;
  const role: WorkRole = WORK_ROLES.includes(run.role as WorkRole) ? run.role as WorkRole : "implement";
  if (sent) return <Notice tone="ok" data-redispatch-sent>{t("redispatch.sent", { id: sent.id, machine: sent.machine })}</Notice>;
  return <form data-redispatch-form className="flex flex-col gap-3 rounded-md border border-line-default bg-surface p-3" onSubmit={e => {
    e.preventDefault();
    void action.run(async () => {
      setSent(await client.call("runs.dispatch", {
        project: run.project, taskId: run.taskId, machineId: machine?.id ?? null,
        role, profileId: selectedProfile || null,
        instructions, reviewAfter: role === "implement" && reviewAfter,
        timeoutMinutes: timeout ? Number(timeout) : null,
        redispatch: { machineId: run.machineId, runId: run.runId, continueBranch },
      }));
      onSent();
    });
  }}>
    <p className="text-xs text-fg-muted">{t("redispatch.hint", { run: run.runId, task: run.taskId })}</p>
    <ErrorNote error={machines.error} />
    {machines.data && !fit.length ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project: run.project })}</Notice> : null}
    <MachineSelect id={`${id}-machine`} machines={fit} any value={machine?.id ?? ""} onChange={value => { setMachineId(value); setProfileId(""); }} />
    <ProfileSelect id={`${id}-profile`} machine={machine} value={selectedProfile} onChange={setProfileId} />
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-timeout`}>{t("runTimeout.duration")}</Label>
      <Input id={`${id}-timeout`} data-redispatch-timeout type="number" min={1} max={ceiling} step={1} value={timeout} placeholder={defaultMinutes == null ? t("runTimeout.profile") : t("runTimeout.automatic", { minutes: defaultMinutes })} className="max-md:h-11 max-md:text-base" onChange={e => setTimeout(e.target.value)} aria-describedby={`${id}-timeout-hint`} />
      <p id={`${id}-timeout-hint`} className="text-xs text-fg-muted">{t("runTimeout.hint")}</p>
    </div>
    <Label htmlFor={`${id}-instructions`}>{t("board.instructions")}</Label>
    <Textarea id={`${id}-instructions`} data-redispatch-instructions className="max-md:text-base" value={instructions} maxLength={4000} onChange={e => setInstructions(e.target.value)} />
    {run.instructions == null ? <Notice tone="info">{t("redispatch.noInstructions")}</Notice> : null}
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <Checkbox data-redispatch-continue checked={continueBranch} disabled={!run.branch} onCheckedChange={value => setContinueBranch(value === true)} />
      {t("redispatch.continueBranch")}
    </label>
    <p className="text-xs text-fg-muted wrap-anywhere">{continueBranch ? t("redispatch.branchHint", { branch: run.branch ?? "" }) : t("redispatch.freshHint")}</p>
    {role === "implement" ? <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={reviewAfter} onCheckedChange={value => setReviewAfter(value === true)} />{t("board.reviewAfter")}</label> : null}
    <ErrorNote error={action.error} />
    <Button data-redispatch-send type="submit" size="sm" className="w-fit max-md:min-h-11" disabled={action.busy || !fit.length}>{t("redispatch.send")}</Button>
  </form>;
}

/** List all attempts, including reviews and cross-machine retries, with direct links to their parents. */
export function TaskRunChain({ project, taskId }: { project: string; taskId: string }) {
  const { client } = useHive();
  const t = useT();
  const tick = usePoll(5000);
  const runs = useQuery(() => client.call("runs.list", { project, taskId, limit: 200 }), [client, project, taskId, tick]);
  return <section className="flex flex-col gap-3" data-task-run-chain>
    <h3 className="text-sm font-medium">{t("redispatch.chain")}</h3>
    <ErrorNote error={runs.error} />
    {runs.data?.length === 0 ? <p className="text-xs text-fg-muted">{t("redispatch.noRuns")}</p> : null}
    <ol className="flex flex-col gap-3">
      {[...(runs.data ?? [])].reverse().map(run => <li key={`${run.machineId}/${run.runId}`} data-task-chain-run={run.runId} className="flex flex-col gap-2 rounded-md border border-line-default p-3 text-xs wrap-anywhere">
        <a className="flex min-h-11 items-center font-medium text-fg-link underline underline-offset-2" href={runLink(run.machineId, run.runId)}>{run.runId} · {run.machine} · {runLabel("agentRole", run.role)}</a>
        <p>{runOutcome(run)} · {formatTime(run.createdAt)}</p>
        {run.parentRun ? <a className="flex min-h-11 items-center text-fg-link underline underline-offset-2" href={runLink(run.parentMachineId ?? run.machineId, run.parentRun)}>{t("redispatch.parent", { run: run.parentRun })}</a> : null}
        <RunRedispatch run={run} onSent={runs.reload} />
      </li>)}
    </ol>
  </section>;
}
