import { useState } from "react";
import { MODEL_TIERS, MODEL_PROFILES, MODEL_EFFORTS, ROUTED_KINDS, TASK_KINDS, TASK_SIZES, selectModel, type ModelRouterSettings, type ModelProject, type TaskKind, type TaskSize, type ModelTier } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { stepModelKind } from "#ui/lib/model-routing.ts";
import type { PipelineStep } from "#ui/lib/pipeline.ts";

export const modelControl = "min-h-(--control-h-touch) min-w-0 w-full rounded-md border border-border bg-card px-2 text-base";
export function choiceText(model: string, effort: string | null, t: TFunction) {
  return [model === "sonnet" ? "Sonnet" : model === "opus" ? "Opus" : model, effort ? MODEL_EFFORTS.includes(effort as typeof MODEL_EFFORTS[number]) ? t(`effort.${effort}` as Parameters<TFunction>[0]) : effort : null].filter(Boolean).join(" · ");
}
export function TierSelect({ value, onChange, disabled, label, inherit = false }: { value: string; onChange: (value: string) => void; disabled: boolean; label: string; inherit?: boolean }) {
  const t = useT();
  return <select className={modelControl} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-model-tier>{inherit ? <option value="">{t("modelRouting.inherit")}</option> : null}{MODEL_TIERS.map((tier) => <option key={tier}>{tier}</option>)}</select>;
}

export function ModelRoutingPanel({ settings, project, onSaved }: { settings: ModelRouterSettings; project: string; onSaved: () => void }) {
  const { client, me } = useHive();
  const can = useCan();
  const t = useT();
  const action = useAction();
  const [draft, setDraft] = useState<ModelProject>(() => structuredClone(settings.projects[project] ?? { enabled: true, profile: "balanced", cells: {} }));
  const [tiers, setTiers] = useState(() => structuredClone(settings.tiers));
  const [saved, setSaved] = useState(false);
  const editable = can(project, "projectSettings") && !action.busy;
  const admin = me.mode === "hub" && me.role === "admin" && !me.access;
  const change = (next: ModelProject) => { setDraft(next); setSaved(false); };
  return <div className="space-y-5" data-model-routing>
    <p className="text-sm text-muted-foreground">{t("modelRouting.cellHint")}</p>
    <label className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={!editable} onChange={(e) => change({ ...draft, enabled: e.target.checked })} data-model-enabled />{t("modelRouting.enabled")}</label>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">{t("modelRouting.profile")}</legend><div className="flex flex-wrap gap-2">{MODEL_PROFILES.map((profile) => <Button key={profile} variant={draft.profile === profile ? "default" : "outline"} className="min-h-(--control-h-touch)" aria-pressed={draft.profile === profile} disabled={!editable} onClick={() => change({ ...draft, profile })} data-model-profile={profile}>{t(`modelRouting.${profile}`)}</Button>)}</div></fieldset>
    <div className="space-y-3">{TASK_KINDS.map((kind) => <fieldset key={kind} className="rounded-lg border border-border p-3" data-model-row={kind}><legend className="px-1 text-sm font-medium">{t(`taskClass.kindValues.${kind}`)}</legend><div className="grid gap-2 md:grid-cols-3">{TASK_SIZES.map((size) => <label key={size} className="min-w-0 text-sm">{t(`taskClass.sizeValues.${size}`)} · {t("modelRouting.inherit")}: {settings.cells[kind][size]}<TierSelect value={draft.cells[kind]?.[size] ?? ""} label={`${kind}/${size}`} inherit disabled={!editable} onChange={(value) => {
      const cells = structuredClone(draft.cells); const row = { ...cells[kind] }; if (value) row[size] = value as ModelTier; else delete row[size]; cells[kind] = row; change({ ...draft, cells });
    }} /></label>)}</div></fieldset>)}</div>
    <div className="flex flex-wrap gap-2"><Button disabled={!editable} className="min-h-(--control-h-touch)" onClick={() => void action.run(async () => { await client.call("modelRouter.set", { project, setting: draft }); setSaved(true); onSaved(); })} data-model-save>{t("modelRouting.save")}</Button><Button variant="outline" disabled={!editable} className="min-h-(--control-h-touch)" onClick={() => change({ ...draft, cells: {} })}>{t("modelRouting.reset")}</Button></div>
    {saved ? <p className="text-sm text-success" role="status">{t("modelRouting.saved")}</p> : null}
    <ErrorNote error={action.error} />
    <p className="text-sm text-muted-foreground">{t("modelRouting.learning")}</p>
    {admin ? <details className="rounded-lg border border-border p-3"><summary className="min-h-(--control-h-touch) cursor-pointer text-sm font-medium">{t("modelRouting.hub")}</summary><p className="text-sm text-muted-foreground">{t("modelRouting.hubHint")}</p><div className="space-y-3">{MODEL_TIERS.map((tier) => <fieldset key={tier} className="space-y-3 rounded-lg border border-border p-3"><legend>{tier}</legend>{ROUTED_KINDS.map((kind) => { const choice = tiers[tier][kind]; return <div key={kind} className="grid gap-2 md:grid-cols-2"><label className="min-w-0 text-sm">{kind} · {t("modelRouting.model")}<input className={modelControl} value={choice?.model ?? ""} disabled={action.busy} pattern={String.raw`[A-Za-z0-9._:\/\[\]\-]{1,200}`} onChange={(e) => setTiers({ ...tiers, [tier]: { ...tiers[tier], [kind]: e.target.value ? { model: e.target.value, effort: choice?.effort ?? null } : null } })} data-hub-model={`${tier}/${kind}`} /></label><label className="min-w-0 text-sm">{kind} · {t("modelRouting.effort")}<select className={modelControl} disabled={(kind === "opencode" || kind === "gemini" || kind === "vibe") || !choice || action.busy} value={choice?.effort ?? ""} onChange={(e) => setTiers({ ...tiers, [tier]: { ...tiers[tier], [kind]: choice ? { ...choice, effort: (e.target.value || null) as typeof choice.effort } : null } })}><option value="">{t("modelRouting.defaultEffort")}</option>{MODEL_EFFORTS.map((effort) => <option key={effort} value={effort}>{t(`effort.${effort}`)}</option>)}</select></label></div>; })}</fieldset>)}</div><Button className="mt-3 min-h-(--control-h-touch)" disabled={action.busy || Object.values(tiers).some((row) => Object.values(row).some((c) => c && !/^[A-Za-z0-9._:/[\]-]{1,200}$/.test(c.model)))} onClick={() => void action.run(async () => { await client.call("modelRouter.set", { project: null, tiers, cells: settings.cells }); onSaved(); })} data-hub-model-save>{t("modelRouting.save")}</Button></details> : null}
  </div>;
}

export function StepModelEditor({ settings, project, step, kind: initialKind = "feature", size: initialSize = "m", onSaved }: { settings: ModelRouterSettings; project: string; step: PipelineStep; kind?: TaskKind; size?: TaskSize; onSaved: () => void }) {
  const { client } = useHive(); const t = useT(); const can = useCan(); const action = useAction();
  const [kind, setKind] = useState(initialKind); const [size, setSize] = useState(initialSize);
  const cell = stepModelKind(step, kind);
  const own = settings.projects[project] ?? { enabled: true, profile: "balanced" as const, cells: {} };
  const [tier, setTier] = useState<string>(cell ? own.cells[cell]?.[size] ?? "" : "");
  const [saved, setSaved] = useState(false);
  const pick = (kind: TaskKind, size: TaskSize) => { setKind(kind); setSize(size); const cell = stepModelKind(step, kind); setTier(cell ? own.cells[cell]?.[size] ?? "" : ""); setSaved(false); };
  if (!cell) return null;
  const editable = can(project, "projectSettings") && !action.busy;
  const previewCells = { ...own.cells, [cell]: { ...own.cells[cell], [size]: tier || settings.cells[cell][size] } } as ModelProject["cells"];
  const preview = selectModel({ ...settings, projects: { ...settings.projects, [project]: { ...own, cells: previewCells } } }, project, { kind: cell, size, risk: "normal", role: step === "review" ? "review" : "implement" });
  return <section className="space-y-3" data-step-model><h3 className="text-sm font-medium">{t("modelRouting.title")}</h3><p className="text-sm text-muted-foreground">{t("modelRouting.stepHint", { kind: cell, size })}</p>{stepModelKind(step, "docs") !== stepModelKind(step, "feature") ? <label className="block text-sm">{t("modelRouting.kind")}<select className={modelControl} value={kind} onChange={(e) => pick(e.target.value as TaskKind, size)}>{TASK_KINDS.map((k) => <option key={k} value={k}>{t(`taskClass.kindValues.${k}`)}</option>)}</select></label> : null}<label className="block text-sm">{t("modelRouting.size")}<select className={modelControl} value={size} onChange={(e) => pick(kind, e.target.value as TaskSize)}>{TASK_SIZES.map((s) => <option key={s} value={s}>{t(`taskClass.sizeValues.${s}`)}</option>)}</select></label><TierSelect value={tier} label={t("modelRouting.tier")} inherit disabled={!editable} onChange={(v) => { setTier(v); setSaved(false); }} />{preview ? <div className="space-y-1 text-sm" data-step-model-preview>{ROUTED_KINDS.map((k) => <p key={k}>{k}: {preview.models[k] ? choiceText(preview.models[k]!.model, preview.models[k]!.effort, t) : "—"} · {preview.tier}</p>)}</div> : <p className="text-sm">{t("modelRouting.off")}</p>}<Button className="min-h-(--control-h-touch)" disabled={!editable} onClick={() => void action.run(async () => { const cells = structuredClone(own.cells); const row = { ...cells[cell] }; if (tier) row[size] = tier as ModelTier; else delete row[size]; cells[cell] = row; await client.call("modelRouter.set", { project, setting: { ...own, cells } }); setSaved(true); onSaved(); })} data-step-model-save>{t("modelRouting.save")}</Button>{saved ? <p role="status" className="text-sm text-success">{t("modelRouting.saved")}</p> : null}<ErrorNote error={action.error} /></section>;
}
