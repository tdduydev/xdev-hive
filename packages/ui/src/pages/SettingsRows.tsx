// Cài đặt service rows (R-72l): design lines 1135–1172, one row = label + hint + one control on the right.
import { useMemo, useState, type ReactNode } from "react";
import { SDLC_GATES, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Toggle } from "@xdev-hive/ui/components/ui/primitives";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fixRoundOptions, gateModeOptions, projectSettingsPatch } from "#ui/lib/settings-rows.ts";
import { scopeProject } from "#ui/lib/scope.ts";
import { AgentPolicyRows } from "#ui/pages/AgentPolicyRows.tsx";

export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return <div className="cx-row"><span><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>{children}</div>;
}

/** Hint + solid action above the card (design `setHint` / `setAction`). */
export function SettingsActionBar({ hint, action, href }: { hint: string; action: string; href: string }) {
  return <div className="cx-actionbar"><span>{hint}</span><Button asChild variant="solid" size="sm" className="max-md:min-h-11"><a href={href}>{action}</a></Button></div>;
}

export function ValuePill({ children }: { children: ReactNode }) {
  return <span className="cx-pill">{children}</span>;
}

/** Quy trình: the project's gates and fix/dispatch limits as rows; presets, plan approval and models stay on #/pipeline. */
export function PolicyRows() {
  const { client, scope } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const [picked, setPicked] = useState("");
  const [tick, setTick] = useState(0);
  const action = useAction();
  const view = useQuery(() => client.call("sdlc.get", {}), [client, tick]);
  const projects = useMemo(() => known.filter((p) => can(p, "projectSettings")).sort(), [known, can]);
  const project = projects.includes(picked) ? picked : projects.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : projects[0];
  const bar = <SettingsActionBar hint={t("settingsTidy.summary.policy")} action={t("settingsTidy.openProcess")} href="#/pipeline" />;
  if (!view.data) return <>{bar}<ErrorNote error={view.error} /></>;
  if (!project) return <>{bar}<p className="text-sm text-fg-secondary">{t("agentPolicy.noProjects")}</p></>;
  const current = view.data.projects[project];
  const ceiling = view.data.ceiling;
  const save = (patch: Parameters<typeof projectSettingsPatch>[1]) => void action.run(async () => {
    await client.call("sdlc.setProject", { project, settings: projectSettingsPatch(current, patch) } as never);
    setTick((n) => n + 1);
  });
  return <>
    {bar}
    <div className="cx-card" data-settings-rows="policy">
      {projects.length > 1 ? <SettingsRow label={t("settingsRows.project")} hint={t("settingsRows.projectHint")}>
        <select className="cx-select" aria-label={t("settingsRows.project")} value={project} onChange={(e) => setPicked(e.target.value)}>{projects.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      </SettingsRow> : null}
      {SDLC_GATES.map((gate: SdlcGate) => <SettingsRow key={gate} label={t(`sdlc.gate.${gate}`)} hint={t(`settingsRows.gateHint.${gate}`)}>
        <select className="cx-select" data-sdlc-gate={gate} aria-label={`${t(`sdlc.gate.${gate}`)} · ${project}`} disabled={action.busy} value={current?.gates[gate] ?? "human"} onChange={(e) => save({ gates: { [gate]: e.target.value as never } })}>
          {gateModeOptions(gate, ceiling[gate]).map((m) => <option key={m} value={m}>{t(`sdlc.mode.${m}`)}</option>)}
        </select>
      </SettingsRow>)}
      <SettingsRow label={t("settingsRows.autoDispatch")} hint={t("settingsRows.autoDispatchHint")}>
        <Toggle aria-label={t("settingsRows.autoDispatch")} checked={!!current?.autoDispatch} disabled={action.busy} onChange={(e) => save({ autoDispatch: e.target.checked })} />
      </SettingsRow>
      <SettingsRow label={t("sdlc.maxFixRounds")} hint={t("settingsRows.fixRoundsHint")}>
        <select className="cx-select" aria-label={t("sdlc.maxFixRounds")} disabled={action.busy} value={current?.maxFixRounds ?? 2} onChange={(e) => save({ maxFixRounds: Number(e.target.value) })}>{fixRoundOptions.map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </SettingsRow>
      <SettingsRow label={t("settingsRows.parallel")} hint={t("settingsRows.parallelHint")}><ValuePill>{current?.maxParallel ?? t("settingsRows.unlimited")}</ValuePill></SettingsRow>
    </div>
    <ErrorNote error={action.error} />
  </>;
}

/** Agent: the policy as editable rows (AgentPolicyRows), plus the per-project AI classify switches. */
export function AgentRows({ classify }: { classify: ReactNode }) {
  return <>
    <AgentPolicyRows />
    <div className="cx-stack">{classify}</div>
  </>;
}
