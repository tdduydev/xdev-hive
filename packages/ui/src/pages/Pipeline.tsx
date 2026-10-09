import { ReleaseQueue } from "#ui/components/ReleaseQueue.tsx";
import { ModelRoutingPanel, StepModelEditor, choiceText } from "#ui/components/ModelRouting.tsx";
import { stepModel, presetModelProfile } from "#ui/lib/model-routing.ts";
import { PlanApprovalFields } from "#ui/components/ImplementationPlans.tsx";
import { ModelsPanel } from "#ui/pages/Models.tsx";
import { useMemo, useState, useEffect } from "react";
import { LockKeyhole } from "lucide-react";
import { ROUTED_KINDS, type RoutedKind, GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Tag } from "@xdev-hive/ui/components/ui/primitives";
import "./pipeline-features.css";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHashParam, useHive, usePoll, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { scopeProject, scopeProjects } from "#ui/lib/scope.ts";
import { FAST_KINDS, PIPELINE_PRESETS, PIPELINE_STEPS, PIPELINE_STEP_GATES as STEP_GATE, passedGates, allPipelineFlows, flowStep, taskStep, gateMetrics, modeWithinCeiling, presetGates, stepCounts, type PipelinePreset, type PipelineStep } from "#ui/lib/pipeline.ts";


export function PipelinePage() {
  const { client, scope } = useHive();
  const allProjects = useProjects();
  const [linkedProject] = useHashParam("project");
  const scopedProjects = allProjects.filter((p) => scope.kind !== "shared" && (scopeProjects(scope)?.includes(p) ?? true));
  const t = useT();
  const can = useCan();
  const mobile = useIsMobile();
  const poll = usePoll(15000);
  const projects = linkedProject && allProjects.includes(linkedProject) && !scopedProjects.includes(linkedProject) ? [linkedProject, ...scopedProjects] : scopedProjects;
  const [linkedFlow] = useHashParam("flow");
  const [selectedProject, setSelectedProject] = useState("");
  const project = (linkedProject && projects.includes(linkedProject) ? linkedProject : (projects.includes(selectedProject) ? selectedProject : "") || scopeProject(scope) || projects[0]) ?? "";
  const [picked, setPicked] = useState<PipelineStep | null>(null);
  const [editGate, setEditGate] = useState<SdlcGate | null>(null);
  const [draftMode, setDraftMode] = useState<GateMode>("human");
  const [fixRounds, setFixRounds] = useState("2");
  const [parallel, setParallel] = useState("");
  const [releaseMachine, setReleaseMachine] = useState("");
  const [planMode, setPlanMode] = useState<"off" | "medium-large" | "all">("off");
  const [planTimeout, setPlanTimeout] = useState("");
  const [preset, setPreset] = useState<PipelinePreset | null>(null);
  const [focusFlow, setFocusFlow] = useState<string | null>(null);
  const [fastKinds, setFastKinds] = useState<Array<(typeof FAST_KINDS)[number]>>([...FAST_KINDS]);
  useEffect(() => { setFocusFlow(null); setPicked(null); setEditGate(null); setPreset(null); }, [project]);
  const [autoDispatch, setAutoDispatch] = useState(false);
  const [allowedAgentKinds, setAllowedAgentKinds] = useState<string[]>([...ROUTED_KINDS]);
  const [modelKind, setModelKind] = useState<RoutedKind>("claude");
  const [modelTab, setModelTab] = useState(false);
  const [tick, setTick] = useState(0);
  const action = useAction();
  const router = useQuery(() => client.call("modelRouter.get", {}), [client, tick]);
  const gateMachines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  const policy = useQuery(() => client.call("sdlc.get", {}), [client, tick, poll]);
  const history = useQuery(async () => {
    if (!project) return { project, flows: [], tasks: [], gates: [], dispatch: { total: 0, tasks: [] } };
    const [flows, tasks, gates, dispatch] = await Promise.all([
      allPipelineFlows(client, { project }),
      client.call("sdlc.flowTasks", { project }),
      (async () => {
        const rows = [];
        let beforeId: number | undefined;
        const since = new Date(Date.now() - 30 * 86400_000).toISOString();
        for (;;) {
          const page = await client.call("sdlc.gates", { project, limit: 200, since, beforeId });
          rows.push(...page);
          if (page.length < 200) return rows;
          beforeId = page.at(-1)!.id;
        }
      })(),
      client.call("sdlc.dispatch", { project, limit: 1 }),
    ]);
    return { project, flows, tasks, gates, dispatch };
  }, [client, project, poll, tick]);
  const data = history.data?.project === project ? history.data : undefined;
  const releases = useQuery(() => project ? client.call("autoRelease.list", { project }) : Promise.resolve(null), [client, project, poll, tick]);
  const current = policy.data?.projects[project];
  const ceiling = policy.data?.ceiling;
  const counts = useMemo(() => {
    const next = stepCounts(data?.flows ?? [], data?.tasks ?? []);
    next.release = releases.data?.releases.filter(r => ["waiting", "queued", "running"].includes(r.state)).length ?? 0;
    next.dispatch = data?.dispatch.total ?? 0;
    return next;
  }, [data, releases.data]);
  const metrics = useMemo(() => gateMetrics(data?.gates ?? []), [data]);
  const flow = (data?.flows ?? []).find((f) => f.taskId === (focusFlow ?? linkedFlow));
  const ownTasks = (data?.tasks ?? []).filter((task) => task.flowTask === flow?.taskId);
  const activeStep = flow?.step === "dispatch" && ownTasks.length ? PIPELINE_STEPS.find((step) => ownTasks.some((task) => taskStep(task) === step)) ?? "done" : flow ? flowStep(flow) : null;
  const featureTaskIds = flow ? [flow.taskId, ...ownTasks.map((task) => task.taskId)].filter((id, i, ids) => ids.indexOf(id) === i).join(",") : "";
  const featureHistory = useQuery(async () => {
    const records = await Promise.all(featureTaskIds.split(",").filter(Boolean).map(async (taskId) => {
      const rows = [];
      let beforeId: number | undefined;
      for (;;) {
        const page = await client.call("sdlc.gates", { project, taskId, since: "1970-01-01T00:00:00.000Z", beforeId, limit: 200 });
        rows.push(...page);
        if (page.length < 200) return rows;
        beforeId = page.at(-1)!.id;
      }
    }));
    return records.flat();
  }, [client, project, featureTaskIds, poll, tick]);
  const passed = passedGates((featureHistory.data ?? []).filter((gate) => gate.project === project && featureTaskIds.split(",").includes(gate.taskId)));
  const editable = !!project && !!current && !!ceiling && can(project, "projectSettings");
  const openGate = (gate: SdlcGate) => { setReleaseMachine(current?.releaseMachine ?? ""); setAutoDispatch(current?.autoDispatch ?? false); setAllowedAgentKinds(current?.allowedAgentKinds ?? [...ROUTED_KINDS]); setPlanMode(current?.planApproval?.mode ?? "off"); setPlanTimeout(current?.planApproval?.timeoutMinutes == null ? "" : String(current.planApproval.timeoutMinutes)); setEditGate(gate); setDraftMode(current?.effective[gate] ?? "human"); setFixRounds(String(current?.maxFixRounds ?? 2)); setParallel(current?.maxParallel == null ? "" : String(current.maxParallel)); };
  const openCount = (step: PipelineStep) => {
    if (step === "release") { document.querySelector("[data-release-queue]")?.scrollIntoView({ block: "nearest" }); return; }
    const q = new URLSearchParams({ project });
    if (step === "dispatch") {
      q.set("pipelineDispatch", "1");
      window.location.hash = `#/tasks?${q}`;
    } else {
      q.set("pipelineStep", step);
      window.location.hash = `#/features?${q}`;
    }
  };
  const save = (gates: Partial<GateModes>, rounds = Number(fixRounds), maxParallel = parallel ? Number(parallel) : null, fastLaneKinds = current?.fastLaneKinds ?? []) => void action.run(async () => {
    const profile = preset && presetModelProfile(preset);
    if (profile && router.data) await client.call("modelRouter.set", { project, setting: { ...(router.data.projects[project] ?? { enabled: true, cells: {} }), profile } });
    await client.call("sdlc.setProject", { project, settings: { gates, releaseMachine: editGate === "release" ? releaseMachine || null : current?.releaseMachine, autoDispatch: preset ? preset === "maximum" : editGate === "dispatch" ? autoDispatch : current?.autoDispatch, allowedAgentKinds: (editGate === "dispatch" ? allowedAgentKinds : current?.allowedAgentKinds) as RoutedKind[] | undefined, maxFixRounds: rounds, maxParallel, fastLaneKinds, planApproval: editGate === "dispatch" ? { mode: planMode, timeoutMinutes: planTimeout ? Number(planTimeout) : null } : current?.planApproval } });
    setEditGate(null); setPreset(null); setTick((x) => x + 1);
  });
  const effective = (g: SdlcGate) => current?.effective[g] ?? "human";
  const gateLabel = (g: SdlcGate) => `${t(`sdlc.gate.${g}`)} · ${t(`sdlc.mode.${effective(g)}`)}${ceiling && ceiling[g] !== "auto" ? ` · ${t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling[g]}`) })}` : ""}`;
  const modelLabel = (step: PipelineStep) => {
    if (!router.data) return t("pipeline.defaultModel");
    if (["idea", "release", "done"].includes(step)) return "—";
    const picked = stepModel(router.data, project, step);
    if (!picked) return t("modelRouting.off");

    return picked.models[modelKind] ? `${choiceText(picked.models[modelKind]!.model, picked.models[modelKind]!.effort, t)} · ${picked.tier} (${picked.reason.split(",")[0]})` : picked.tier;
  };
  const modelEditor = (step: PipelineStep) => router.data ? <StepModelEditor key={`${project}/${step}`} settings={router.data} project={project} step={step} onSaved={() => setTick((x) => x + 1)} /> : null;
  const stepRows = (step: PipelineStep) => [
    ...(data?.flows ?? []).filter((f) => f.step !== "dispatch" && flowStep(f) === step).map((f) => ({ id: f.taskId, title: f.dir ?? f.taskId, at: f.updatedAt })),
    ...(data?.tasks ?? []).filter((task) => taskStep(task) === step).map((task) => ({ id: task.taskId, title: task.flowTask, at: task.updatedAt })),
  ];
  const sel: PipelineStep = picked ?? activeStep ?? "review";
  const selGate = STEP_GATE[sel];
  const selMode = selGate ? effective(selGate) : null;
  const rows = stepRows(sel);
  const hours = (v: number | null) => v === null ? "—" : `${Math.round(v * 10) / 10}h`;
  const stepMode = (step: PipelineStep) => STEP_GATE[step] ? effective(STEP_GATE[step]!) : null;
  if (!project) return <Page><p>{t("pipeline.noProject")}</p></Page>;
  return <Page wide className="min-w-0 gap-0 p-0">
    <div className="pf-tabs" role="tablist" aria-label={t("pipeline.title")}><button role="tab" type="button" className="pf-tab" aria-selected={!modelTab} onClick={() => setModelTab(false)} data-model-tab="steps">{t("pipeline.flowTab")}</button><button role="tab" type="button" className="pf-tab" aria-selected={modelTab} onClick={() => setModelTab(true)} data-model-tab="models">{t("modelRouting.title")}</button></div>
    {scopeProject(scope) === null || projects.length > 1 || (data?.flows.length ?? 0) > 0 ? <div className="pf-pickers">
      {scopeProject(scope) === null ? <label className="flex items-center gap-2">{t("pipeline.project")}<select value={project} onChange={(e) => { setSelectedProject(e.target.value); window.location.hash = `#/pipeline?project=${encodeURIComponent(e.target.value)}`; }} data-pipeline-project>{projects.map((p) => <option key={p}>{p}</option>)}</select></label> : null}
      <label className="flex items-center gap-2">{t("modelRouting.planKind")}<select value={modelKind} onChange={(e) => setModelKind(e.target.value as RoutedKind)}>{ROUTED_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      <label className="flex items-center gap-2">{t("pipeline.feature")}<select value={focusFlow ?? linkedFlow ?? ""} onChange={(e) => setFocusFlow(e.target.value)} data-pipeline-feature><option value="">{t("pipeline.allFeatures")}</option>{(data?.flows ?? []).map((f) => <option key={f.taskId} value={f.taskId}>{f.taskId}</option>)}</select></label>
    </div> : null}
    {modelTab ? router.data ? <div className="space-y-6"><ModelRoutingPanel key={project} settings={router.data} project={project} onSaved={() => router.reload()} /><ModelsPanel settings={router.data} project={project} /></div> : <ErrorNote error={router.error} /> : <>
    <div className="pf-presets" aria-label={t("pipeline.presets")}>
      <span className="pf-cap">{t("pipeline.presetsLabel")}</span>
      {PIPELINE_PRESETS.map((p) => <button key={p} type="button" className="pf-tagbtn" onClick={() => { setFastKinds([...FAST_KINDS]); setPreset(p); }} disabled={!ceiling || !router.data || action.busy} data-pipeline-preset={p}><Tag active={preset === p}>{t(`pipeline.preset.${p}`)}</Tag></button>)}
      <span className="pf-spacer" />
      <span className="pf-cap">{t("pipeline.metricsNote")}</span>
    </div>
    <div className="pf-steps" data-pipeline-steps>{PIPELINE_STEPS.slice(0, -1).map((step, i) => { const mode = stepMode(step); const n = counts[step]; return <button key={step} type="button" className="pf-step" aria-pressed={sel === step} onClick={() => setPicked(step)} data-pipeline-step={step} data-active={activeStep === step} aria-label={`${t(`pipeline.step.${step}`)} · ${mode ? t(`sdlc.mode.${mode}`) : t("pipeline.noGateShort")}`}>
      <span className="pf-step-n">{String(i + 1).padStart(2, "0")}</span><span className="pf-step-label">{t(`pipeline.step.${step}`)}</span>
      <span className="pf-step-mode"><span className="pf-dot" data-tone={mode ?? "none"} />{mode ? t(`sdlc.mode.${mode}`) : t("pipeline.noGateShort")}</span>
      <span className="pf-step-count">{n ? t("pipeline.countShort", { count: n }) : t("pipeline.empty")}</span></button>; })}</div>
    <div className="pf-grid">
      <div className="pf-main" data-pipeline-detail={sel}>
        <div className="pf-head"><span className="pf-over">{t("pipeline.gateOf", { gate: t(`pipeline.step.${sel}`) })}</span><h2 className="pf-h2">{selGate ? t(`sdlc.gateHint.${selGate}`) : t(`pipeline.stepHint.${sel as "idea" | "build" | "done"}`)}</h2></div>
        {selGate ? <div className="pf-group"><span className="pf-label">{t("pipeline.whoPasses")}</span><div className="pf-modes">{GATE_MODES.filter(mode => selGate !== "release" || mode !== "ai").map((mode) => { const locked = !!ceiling && !modeWithinCeiling(mode, ceiling[selGate]); return <button key={mode} type="button" className="pf-mode" aria-pressed={selMode === mode} disabled={!editable || locked} onClick={() => { openGate(selGate); setDraftMode(mode); }} data-pipeline-mode-pick={mode}><b>{t(`sdlc.mode.${mode}`)}</b><span>{locked ? <><LockKeyhole aria-hidden="true" className="mr-1 inline size-3" />{t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling![selGate]}`) })}</> : t(`sdlc.modeHint.${mode}`)}</span></button>; })}</div></div> : null}
        <div className="pf-kv">
          <div><span>{t("pipeline.wait")}</span><b>{hours(selGate ? metrics[selGate].medianHours : null)}</b></div>
          <div><span>{t("pipeline.firstPass")}</span><b>{selGate && metrics[selGate].firstPass !== null ? `${metrics[selGate].firstPass}%` : "—"}</b></div>
          <div><span>{t("pipeline.approverLabel")}</span><b>{selMode === "human" ? (sel === "test" ? t("pipeline.qa") : sel === "review" || sel === "merge" ? t("pipeline.reviewer") : t("pipeline.manager")) : "—"}</b></div>
          <div><span>{t("pipeline.modelLabel")}</span><b>{modelLabel(sel)}</b></div>
        </div>
        {!selGate ? modelEditor(sel) : null}
      </div>
      <div className="pf-side">
        <span className="pf-side-title">{t("pipeline.here")}<a href="#" onClick={(e) => { e.preventDefault(); openCount(sel); }} data-pipeline-count={sel}>{t("pipeline.count", { count: counts[sel] })}</a></span>
        {rows.slice(0, 8).map((row) => <div key={`${row.id}`} className="pf-item"><code>{row.id}</code><span>{row.title}</span><small>{formatTime(row.at)}</small></div>)}
        {!rows.length ? <span className="pf-empty">{t("pipeline.nothingHere")}</span> : null}
      </div>
    </div>
    <div className="mt-6"><ReleaseQueue project={project} onChanged={() => setTick(x => x + 1)} /></div>
    <ErrorNote error={router.error ?? policy.error ?? history.error ?? featureHistory.error ?? action.error} />
    <Sheet open={!!editGate} onOpenChange={(open) => !open && setEditGate(null)}><SheetContent className="w-full max-md:!w-full overflow-y-auto sm:max-w-md max-md:[&_button]:min-h-(--control-h-touch) max-md:[&_input:not([type=checkbox])]:min-h-(--control-h-touch) max-md:[&_input[type=checkbox]]:min-h-0 max-md:[&>button]:min-w-(--control-h-touch)" data-pipeline-editor><SheetHeader><SheetTitle>{editGate && t(`sdlc.gate.${editGate}`)}</SheetTitle><SheetDescription>{editGate && t(`sdlc.gateHint.${editGate}`)}</SheetDescription></SheetHeader>{editGate ? <div className="space-y-5 p-4"><div className="space-y-2">{GATE_MODES.filter(mode => editGate !== "release" || mode !== "ai").map((mode) => { const locked = !!ceiling && !modeWithinCeiling(mode, ceiling[editGate]); return <button key={mode} className={`flex min-h-(--control-h-touch) w-full items-center gap-3 rounded-lg border p-3 text-left ${draftMode === mode ? "border-primary bg-selected" : "border-border"}`} disabled={!editable || locked} onClick={() => setDraftMode(mode)} aria-pressed={draftMode === mode} data-pipeline-mode={mode}><span>{t(`sdlc.mode.${mode}`)}</span><span className="text-xs text-muted-foreground">{t(`sdlc.modeHint.${mode}`)}</span>{locked ? <span className="ml-auto flex items-center gap-1 text-xs text-warning"><LockKeyhole aria-hidden="true" className="size-4 shrink-0" />{t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling![editGate]}`) })}</span> : null}</button>; })}</div><p className="text-sm text-muted-foreground">{t("pipeline.approver", { role: editGate === "review" || editGate === "merge" ? t("pipeline.reviewer") : t("pipeline.manager") })}</p>{editGate === "fix" ? <label className="block text-sm">{t("sdlc.maxFixRounds")}<Input className="mt-1 min-h-(--control-h-touch) text-base" type="number" min={0} max={5} value={fixRounds} onChange={(e) => setFixRounds(e.target.value)} data-pipeline-fix /></label> : null}{editGate === "dispatch" ? <label className="block text-sm">{t("sdlc.maxParallel")}<Input className="mt-1 min-h-(--control-h-touch) text-base" type="number" min={1} max={20} placeholder="∞" value={parallel} onChange={(e) => setParallel(e.target.value)} data-pipeline-parallel /></label> : null}{editGate === "dispatch" ? <fieldset className="space-y-2"><label className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={autoDispatch} onChange={(e) => setAutoDispatch(e.target.checked)} disabled={!editable || action.busy} data-auto-dispatch />{t("pipeline.autoDispatch")}</label><p className="text-sm text-muted-foreground">{t("pipeline.autoDispatchHint")}</p><p className="text-sm">{t("pipeline.allowedAgentKinds")}</p>{ROUTED_KINDS.map((kind) => <label key={kind} className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={allowedAgentKinds.includes(kind)} disabled={!editable || action.busy} onChange={(e) => setAllowedAgentKinds((old) => e.target.checked ? [...old, kind] : old.filter((k) => k !== kind))} data-auto-kind={kind} />{kind}</label>)}</fieldset> : null}{editGate === "dispatch" ? <PlanApprovalFields mode={planMode} onMode={setPlanMode} timeout={planTimeout} onTimeout={setPlanTimeout} disabled={!editable || action.busy} /> : null}{editGate === "release" ? <label className="block text-sm">{t("autoRelease.machine")}<select className="mt-1 min-h-(--control-h-touch) w-full rounded-md border border-border bg-card px-3 text-base" value={releaseMachine} onChange={e => setReleaseMachine(e.target.value)} data-release-machine><option value="">—</option>{releaseMachine && !gateMachines.data?.some(m => m.id === releaseMachine) ? <option value={releaseMachine}>{releaseMachine}</option> : null}{(gateMachines.data ?? []).filter(m => m.projects.includes(project)).map(m => <option key={m.id} value={m.id}>{m.machine} · {m.id}</option>)}</select></label> : modelEditor(editGate)}<Button className="min-h-(--control-h-touch)" disabled={!editable || action.busy || (planTimeout !== "" && (!Number.isInteger(Number(planTimeout)) || Number(planTimeout) < 1 || Number(planTimeout) > 10080)) || !fixRounds || !Number.isInteger(Number(fixRounds)) || Number(fixRounds) < 0 || Number(fixRounds) > 5 || (parallel !== "" && (!Number.isInteger(Number(parallel)) || Number(parallel) < 1 || Number(parallel) > 20))} onClick={() => save({ ...current?.gates, [editGate]: draftMode })} data-pipeline-save>{t("sdlc.save")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
    <Sheet open={!!preset} onOpenChange={(open) => !open && setPreset(null)}><SheetContent className="w-full max-md:!w-full overflow-y-auto sm:max-w-md max-md:[&_button]:min-h-(--control-h-touch) max-md:[&_input:not([type=checkbox])]:min-h-(--control-h-touch) max-md:[&_input[type=checkbox]]:min-h-0 max-md:[&>button]:min-w-(--control-h-touch)" data-pipeline-preview><SheetHeader><SheetTitle>{preset && t(`pipeline.preset.${preset}`)}</SheetTitle><SheetDescription>{t("pipeline.preview")}</SheetDescription></SheetHeader>{preset && ceiling ? <div className="space-y-4 p-4"><div className="space-y-2">{SDLC_GATES.map((g) => { const next = presetGates(preset, ceiling, current?.effective)[g]; return <div key={g} className="flex justify-between gap-2 border-b border-border py-2 text-sm" data-pipeline-change={g}><span>{t(`sdlc.gate.${g}`)}</span><span>{t(`sdlc.mode.${effective(g)}`)} → {t(`sdlc.mode.${next}`)}</span></div>; })}</div><p className="text-sm" data-auto-dispatch-preview>{t("pipeline.autoDispatch")}: {t(`sdlc.mode.${current?.autoDispatch ? "auto" : "human"}`)} → {t(`sdlc.mode.${preset === "maximum" ? "auto" : "human"}`)}</p><div className="text-sm" data-pipeline-fast-change>{t("pipeline.fastKinds", { kinds: (current?.fastLaneKinds ?? []).map((kind) => t(`taskClass.kindValues.${kind}`)).join(" · ") || "—" })} → {preset === "fast" ? fastKinds.map((kind) => t(`taskClass.kindValues.${kind}`)).join(" · ") || "—" : "—"}</div>{preset === "fast" ? <fieldset className="space-y-2"><legend className="text-sm">{t("pipeline.fastSelect")}</legend>{FAST_KINDS.map((kind) => <label key={kind} className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={fastKinds.includes(kind)} onChange={(e) => setFastKinds((old) => e.target.checked ? [...old, kind] : old.filter((k) => k !== kind))} data-pipeline-fast-kind={kind} />{t(`taskClass.kindValues.${kind}`)}</label>)}</fieldset> : null}<p className="text-sm text-muted-foreground" data-pipeline-model-change>{t("modelRouting.profile")}: {t(`modelRouting.${router.data?.projects[project]?.profile ?? "balanced"}`)} → {t(`modelRouting.${presetModelProfile(preset) ?? router.data?.projects[project]?.profile ?? "balanced"}`)}</p><Button className="min-h-(--control-h-touch)" disabled={!editable || action.busy} onClick={() => save(presetGates(preset, ceiling, current?.effective), current?.maxFixRounds ?? 2, current?.maxParallel ?? null, preset === "fast" ? fastKinds : [])} data-pipeline-apply>{t("pipeline.apply")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
    </>}
  </Page>;
}
