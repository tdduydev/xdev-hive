import { useState } from "react";
import type { Machine, MachineRunnerSettings, ReportedProfile } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

const control = "min-h-11 text-base md:min-h-7 md:text-xs";

export function MachineRunnerControls({ machine: m, onChanged }: { machine: Machine; onChanged: () => void }) {
  const t = useT();
  if (!m.runnerSettings) return <p className="text-xs text-fg-muted">{t("machines.profileOldApp")}</p>;
  const value = { ...m.runnerSettings, ...m.runnerChange?.settings };
  return <div className="space-y-2 rounded-md border border-dashed p-2">
    <RunnerForm key={JSON.stringify(value)} machine={m} value={value} onChanged={onChanged} />
    {m.runnerChange ? <p role="status" className="text-xs text-warning">{t("machines.runnerWaiting", { who: m.runnerChange.requestedBy })}</p> : null}
    <p className="text-xs text-fg-muted">{t("machines.runnerHint")}</p>
  </div>;
}

function RunnerForm({ machine: m, value, onChanged }: { machine: Machine; value: MachineRunnerSettings; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [parallel, setParallel] = useState(String(value.maxParallel));
  const [enabled, setEnabled] = useState(value.mrEnabled);
  const [when, setWhen] = useState(value.mrWhen);
  const valid = parallel.trim() !== "" && Number.isInteger(Number(parallel)) && Number(parallel) >= 1 && Number(parallel) <= 8;
  const changed = Number(parallel) !== value.maxParallel || enabled !== value.mrEnabled || when !== value.mrWhen;
  return <form className="space-y-3" data-runner-form onSubmit={e => {
    e.preventDefault();
    if (!valid || !changed) return;
    void action.run(async () => {
      const settings: Partial<MachineRunnerSettings> = {};
      if (Number(parallel) !== value.maxParallel) settings.maxParallel = Number(parallel);
      if (enabled !== value.mrEnabled) settings.mrEnabled = enabled;
      if (when !== value.mrWhen) settings.mrWhen = when;
      await client.call("machines.setRunner", { machineId: m.id, settings });
      onChanged();
    });
  }}>
    <label className="flex flex-col gap-1 text-xs">{t("agents.maxAtOnce")}<Input data-runner-parallel type="number" min={1} max={8} required value={parallel} onChange={e => setParallel(e.target.value)} disabled={action.busy} className={control} /></label>
    <label className="flex min-h-11 items-center gap-2 text-xs md:min-h-7"><input data-runner-mr type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={action.busy} />{t("machines.runnerMr")}</label>
    <label className="flex flex-col gap-1 text-xs">{t("machines.runnerMrWhen")}<select data-runner-when className={`${control} w-full rounded-md border border-border bg-card px-2`} value={when} onChange={e => setWhen(e.target.value as MachineRunnerSettings["mrWhen"])} disabled={action.busy}>
      <option value="after_review">{t("projects.mrAfterReview")}</option><option value="after_success">{t("projects.mrAfterSuccess")}</option>
    </select></label>
    <Button data-runner-save size="sm" className={control} disabled={action.busy || !valid || !changed}>{t(action.busy ? "machines.runnerSaving" : "sdlc.save")}</Button>
    <ErrorNote error={action.error} />
  </form>;
}

export function ProfileThresholds({ machine: m, profile: p, onChanged }: { machine: Machine; profile: ReportedProfile; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const waiting = m.profileChanges.find(c => c.profileId === p.id);
  const session = waiting?.stopAtSession ?? p.stopAtSession!;
  const week = waiting?.stopAtWeek ?? p.stopAtWeek!;
  const [draftSession, setSession] = useState(String(session));
  const [draftWeek, setWeek] = useState(String(week));
  const valid = [draftSession, draftWeek].every(v => v.trim() !== "" && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100);
  return <form className="w-full space-y-2" data-profile-thresholds={p.id} onSubmit={e => {
    e.preventDefault();
    if (!valid) return;
    void action.run(async () => {
      await client.call("machines.setProfile", { machineId: m.id, profileId: p.id, stopAtSession: Number(draftSession), stopAtWeek: Number(draftWeek) });
      onChanged();
    });
  }}>
    <label className="flex flex-col gap-1 text-xs">{t("agents.stopAtSession")}<Input data-stop-session type="number" min={1} max={100} required value={draftSession} onChange={e => setSession(e.target.value)} disabled={action.busy} className={control} /></label>
    <label className="flex flex-col gap-1 text-xs">{t("agents.stopAtWeek")}<Input data-stop-week type="number" min={1} max={100} required value={draftWeek} onChange={e => setWeek(e.target.value)} disabled={action.busy} className={control} /></label>
    <Button data-threshold-save size="sm" className={control} disabled={action.busy || !valid || (Number(draftSession) === session && Number(draftWeek) === week)}>{t(action.busy ? "machines.runnerSaving" : "sdlc.save")}</Button>
    <ErrorNote error={action.error} />
  </form>;
}
