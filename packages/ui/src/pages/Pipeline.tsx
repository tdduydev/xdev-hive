import { ModelRoutingPanel, StepModelEditor, choiceText } from "#ui/components/ModelRouting.tsx";
import { stepModel, presetModelProfile } from "#ui/lib/model-routing.ts";
import { useMemo, useState, useEffect } from "react";
import { ReactFlow, Handle, Position, type Node, type NodeProps, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { ArrowRight, Bot, LockKeyhole, UserRound, Check } from "lucide-react";
import { ROUTED_KINDS, type RoutedKind, GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { useAction, useCan, useHashParam, useHive, usePoll, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { scopeProject, scopeProjects } from "#ui/lib/scope.ts";
import { FAST_KINDS, PIPELINE_PRESETS, PIPELINE_STEPS, PIPELINE_STEP_GATES as STEP_GATE, passedGates, allPipelineFlows, flowStep, taskStep, gateMetrics, modeWithinCeiling, presetGates, stepCounts, type PipelinePreset, type PipelineStep } from "#ui/lib/pipeline.ts";

type StepData = Record<string, unknown> & { step: PipelineStep; count: number; median: number | null; pass: number | null; active: boolean; onOpen: (step: PipelineStep) => void; onCount: (step: PipelineStep) => void; label: string; countLabel: string; waitLabel: string; passLabel: string; modelLabel: string; roleLabel: string };
type GateData = Record<string, unknown> & { gate: SdlcGate; mode: GateMode; locked: boolean; passed: boolean; onOpen: (gate: SdlcGate) => void; label: string };
// React Flow gives a node that is neither draggable nor selectable pointer-events: none, so a mouse click on its
// buttons would land on the pane behind it; pointer-events-auto takes the clicks back.
function StepNode({ data }: NodeProps<Node<StepData>>) {
  return <><Handle type="target" position={Position.Left} isConnectable={false} /><div className={`pointer-events-auto rounded-xl border bg-card p-3 shadow-sm ${data.active ? "border-primary ring-2 ring-primary/30" : "border-border"}`} data-pipeline-step={data.step} data-active={data.active}>
    <button className="nodrag min-h-(--control-h-touch) w-full text-left font-semibold text-fg-strong" onClick={() => data.onOpen(data.step)}>{data.label}</button><div className="text-xs text-muted-foreground">{data.roleLabel}</div>
    <a className="nodrag block min-h-(--control-h-touch) text-sm text-fg-link underline underline-offset-2" href="#" onClick={(e) => { e.preventDefault(); data.onCount(data.step); }} data-pipeline-count={data.step}>{data.countLabel.replace("{count}", String(data.count))}</a>
    <div className="space-y-1 text-xs text-muted-foreground"><div>{data.waitLabel}: {data.median === null ? "—" : `${Math.round(data.median * 10) / 10}h`}</div><div>{data.passLabel}: {data.pass === null ? "—" : `${data.pass}%`}</div><div>{data.modelLabel}</div></div>
  </div><Handle type="source" position={Position.Right} isConnectable={false} /></>;
}
const MODE_ICON = { human: UserRound, ai: Bot, auto: ArrowRight };
function GateNode({ data }: NodeProps<Node<GateData>>) {
  const Icon = MODE_ICON[data.mode];
  return <><Handle type="target" position={Position.Left} isConnectable={false} /><button className="nodrag pointer-events-auto flex h-(--control-h-touch) w-(--control-h-touch) items-center justify-center rounded-full border border-border bg-card text-fg-strong shadow-sm" aria-label={data.label} title={data.label} onClick={() => data.onOpen(data.gate)} data-pipeline-gate={data.gate} data-passed={data.passed}><Icon aria-hidden="true" className="size-4" />{data.passed ? <Check aria-hidden="true" className="size-3 text-success" /> : null}{data.locked ? <LockKeyhole aria-hidden="true" className="ml-0.5 size-3 text-warning" /> : null}</button><Handle type="source" position={Position.Right} isConnectable={false} /></>;
}
const NODE_TYPES = { step: StepNode, gate: GateNode };

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
  const [infoStep, setInfoStep] = useState<PipelineStep | null>(null);
  const [editGate, setEditGate] = useState<SdlcGate | null>(null);
  const [draftMode, setDraftMode] = useState<GateMode>("human");
  const [fixRounds, setFixRounds] = useState("2");
  const [parallel, setParallel] = useState("");
  const [preset, setPreset] = useState<PipelinePreset | null>(null);
  const [focusFlow, setFocusFlow] = useState<string | null>(null);
  const [fastKinds, setFastKinds] = useState<Array<(typeof FAST_KINDS)[number]>>([...FAST_KINDS]);
  useEffect(() => { setFocusFlow(null); setInfoStep(null); setEditGate(null); setPreset(null); }, [project]);
  const [modelKind, setModelKind] = useState<RoutedKind>("claude");
  const [modelTab, setModelTab] = useState(false);
  const [tick, setTick] = useState(0);
  const action = useAction();
  const router = useQuery(() => client.call("modelRouter.get", {}), [client, tick]);
  const policy = useQuery(() => client.call("sdlc.get", {}), [client, tick, poll]);
  const history = useQuery(async () => {
    if (!project) return { project, flows: [], tasks: [], gates: [], work: [] };
    const [flows, tasks, gates, work] = await Promise.all([
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
      client.call("tasks.list", { project }),
    ]);
    return { project, flows, tasks, gates, work };
  }, [client, project, poll, tick]);
  const data = history.data?.project === project ? history.data : undefined;
  const current = policy.data?.projects[project];
  const ceiling = policy.data?.ceiling;
  const counts = useMemo(() => {
    const next = stepCounts(data?.flows ?? [], data?.tasks ?? []);
    const owned = new Set([...(data?.flows ?? []).map((f) => f.taskId), ...(data?.tasks ?? []).map((task) => task.taskId)]);
    next.dispatch += (data?.work ?? []).filter((task) => !owned.has(task.id) && task.status === "todo" && current?.fastLaneKinds.includes(task.kind as (typeof FAST_KINDS)[number])).length;
    return next;
  }, [data, current]);
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
  const openGate = (gate: SdlcGate) => { setEditGate(gate); setDraftMode(current?.effective[gate] ?? "human"); setFixRounds(String(current?.maxFixRounds ?? 2)); setParallel(current?.maxParallel == null ? "" : String(current.maxParallel)); };
  const openStep = (step: PipelineStep) => { const gate = STEP_GATE[step]; if (gate) openGate(gate); else setInfoStep(step); };
  const openCount = (step: PipelineStep) => {
    const q = new URLSearchParams({ project });
    if (step === "dispatch") {
      const rows = data;
      const ids = new Set((rows?.tasks ?? []).filter((task) => taskStep(task) === "dispatch").map((task) => task.taskId));
      for (const flow of rows?.flows ?? []) if (flow.step !== "dispatch" && flowStep(flow) === "dispatch") ids.add(flow.taskId);
      const owned = new Set([...(rows?.flows ?? []).map((flow) => flow.taskId), ...(rows?.tasks ?? []).map((task) => task.taskId)]);
      for (const task of rows?.work ?? []) if (!owned.has(task.id) && task.status === "todo" && current?.fastLaneKinds.some((kind) => kind === task.kind)) ids.add(task.id);
      q.set("ids", [...ids].join(","));
      window.location.hash = `#/tasks?${q}`;
    } else {
      q.set("pipelineStep", step);
      window.location.hash = `#/features?${q}`;
    }
  };
  const save = (gates: Partial<GateModes>, rounds = Number(fixRounds), maxParallel = parallel ? Number(parallel) : null, fastLaneKinds = current?.fastLaneKinds ?? []) => void action.run(async () => {
    await client.call("sdlc.setProject", { project, settings: { gates, maxFixRounds: rounds, maxParallel, fastLaneKinds } });
    const profile = preset && presetModelProfile(preset);
    if (profile && router.data) await client.call("modelRouter.set", { project, setting: { ...(router.data.projects[project] ?? { enabled: true, cells: {} }), profile } });
    setEditGate(null); setPreset(null); setTick((x) => x + 1);
  });
  const effective = (g: SdlcGate) => current?.effective[g] ?? "human";
  const gateLabel = (g: SdlcGate) => `${t(`sdlc.gate.${g}`)} · ${t(`sdlc.mode.${effective(g)}`)}${ceiling && ceiling[g] !== "auto" ? ` · ${t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling[g]}`) })}` : ""}`;
  const modelLabel = (step: PipelineStep) => {
    if (!router.data) return t("pipeline.defaultModel");
    if (["idea", "done"].includes(step)) return "—";
    const picked = stepModel(router.data, project, step);
    if (!picked) return t("modelRouting.off");

    return picked.models[modelKind] ? `${choiceText(picked.models[modelKind]!.model, picked.models[modelKind]!.effort, t)} · ${picked.tier} (${picked.reason.split(",")[0]})` : picked.tier;
  };
  const modelEditor = (step: PipelineStep) => router.data ? <StepModelEditor key={`${project}/${step}`} settings={router.data} project={project} step={step} onSaved={() => setTick((x) => x + 1)} /> : null;
  const stepData = (step: PipelineStep): StepData => ({ step, count: counts[step], median: STEP_GATE[step] ? metrics[STEP_GATE[step]!].medianHours : null, pass: STEP_GATE[step] ? metrics[STEP_GATE[step]!].firstPass : null, active: activeStep === step, onOpen: openStep, onCount: openCount, label: t(`pipeline.step.${step}`), countLabel: t("pipeline.count"), waitLabel: t("pipeline.wait"), passLabel: t("pipeline.firstPass"), modelLabel: modelLabel(step), roleLabel: STEP_GATE[step] ? t("pipeline.approver", { role: step === "review" || step === "merge" ? t("pipeline.reviewer") : t("pipeline.manager") }) : t("pipeline.automaticStep") });
  const gateData = (gate: SdlcGate): GateData => ({ gate, mode: effective(gate), locked: !!ceiling && ceiling[gate] !== "auto", passed: passed.has(gate), onOpen: openGate, label: `${gateLabel(gate)}${passed.has(gate) ? ` · ${t("pipeline.passed")}` : ""}` });
  // Fixed nodes still contain controls; React Flow otherwise disables pointer events when drag and selection are off.
  const nodes = useMemo(() => {
    const out: Node[] = [];
    let x = 0;
    PIPELINE_STEPS.forEach((step, i) => {
      out.push({ id: step, type: "step", position: { x, y: 38 }, data: stepData(step), draggable: false, selectable: false, style: { width: 158, pointerEvents: "all" } });
      x += 174;
      const gate = STEP_GATE[step];
      if (gate && i < PIPELINE_STEPS.length - 1) { out.push({ id: `gate:${gate}`, type: "gate", position: { x, y: 98 }, data: gateData(gate), draggable: false, selectable: false, style: { pointerEvents: "all" } }); x += 62; }
    });
    return out;
  }, [current, ceiling, counts, metrics, activeStep, project, t, data, featureHistory.data, focusFlow, linkedFlow, router.data, modelKind]);
  const edges: Edge[] = nodes.slice(1).map((node, i) => ({ id: `${nodes[i]!.id}-${node.id}`, source: nodes[i]!.id, target: node.id, type: "straight", style: { stroke: "var(--border-strong)" } }));
  if (!project) return <Page><p>{t("pipeline.noProject")}</p></Page>;
  return <Page wide className="min-w-0" >
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold text-fg-strong">{t("pipeline.title")}</h1><p className="text-sm text-muted-foreground">{t("pipeline.intro")}</p></div>
      <label className="flex max-w-full min-w-0 flex-wrap items-center gap-2 text-sm">{t("pipeline.project")}<select className="min-h-(--control-h-touch) max-w-full rounded-md border border-border bg-card px-3 text-base" value={project} onChange={(e) => { setSelectedProject(e.target.value); window.location.hash = `#/pipeline?project=${encodeURIComponent(e.target.value)}`; }} data-pipeline-project>{projects.map((p) => <option key={p}>{p}</option>)}</select></label></div>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("pipeline.title")}><Button role="tab" aria-selected={!modelTab} className="min-h-(--control-h-touch)" variant={!modelTab ? "default" : "outline"} onClick={() => setModelTab(false)} data-model-tab="steps">{t("modelRouting.steps")}</Button><Button role="tab" aria-selected={modelTab} className="min-h-(--control-h-touch)" variant={modelTab ? "default" : "outline"} onClick={() => setModelTab(true)} data-model-tab="models">{t("modelRouting.title")}</Button></div>
    {modelTab ? router.data ? <ModelRoutingPanel key={project} settings={router.data} project={project} onSaved={() => router.reload()} /> : <ErrorNote error={router.error} /> : <>
    <div className="flex flex-wrap gap-2" aria-label={t("pipeline.presets")}>{PIPELINE_PRESETS.map((p) => <Button key={p} variant="outline" className="max-md:min-h-(--control-h-touch)" onClick={() => { setFastKinds([...FAST_KINDS]); setPreset(p); }} disabled={!ceiling || !router.data || action.busy} data-pipeline-preset={p}>{t(`pipeline.preset.${p}`)}</Button>)}</div>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t("modelRouting.planKind")}<select className="min-h-(--control-h-touch) rounded-md border border-border bg-card px-3 text-base" value={modelKind} onChange={(e) => setModelKind(e.target.value as RoutedKind)}>{ROUTED_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t("pipeline.feature")}<select className="min-h-(--control-h-touch) min-w-48 max-w-full rounded-md border border-border bg-card px-3 text-base" value={focusFlow ?? linkedFlow ?? ""} onChange={(e) => setFocusFlow(e.target.value)} data-pipeline-feature><option value="">{t("pipeline.allFeatures")}</option>{(data?.flows ?? []).map((f) => <option key={f.taskId} value={f.taskId}>{f.taskId}</option>)}</select></label>
    {mobile ? <div className="flex flex-col gap-2" data-pipeline-mobile>{PIPELINE_STEPS.map((step) => { const d = stepData(step); const gate = STEP_GATE[step]; return <div key={step} className="space-y-2"><div className={`rounded-xl border p-3 ${d.active ? "border-primary bg-selected" : "border-border bg-card"}`} data-pipeline-step={step} data-active={d.active}><button className="min-h-(--control-h-touch) w-full text-left font-semibold" onClick={() => openStep(step)}>{d.label}</button><p className="text-xs text-muted-foreground">{d.roleLabel}</p><button className="min-h-(--control-h-touch) text-left text-sm text-fg-link underline" onClick={() => openCount(step)} data-pipeline-count={step}>{t("pipeline.count", { count: d.count })}</button><p className="text-xs text-muted-foreground">{t("pipeline.wait")}: {d.median == null ? "—" : `${Math.round(d.median * 10) / 10}h`} · {t("pipeline.firstPass")}: {d.pass == null ? "—" : `${d.pass}%`} · {d.modelLabel}</p></div>{gate ? <button className="flex min-h-(--control-h-touch) w-full items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm" onClick={() => openGate(gate)} data-pipeline-gate={gate} data-passed={passed.has(gate)} aria-label={gateData(gate).label}>{passed.has(gate) ? <Check aria-hidden="true" className="size-4 text-success" /> : null}{t(`sdlc.gate.${gate}`)} · {t(`sdlc.mode.${effective(gate)}`)}{ceiling?.[gate] !== "auto" ? <LockKeyhole aria-hidden="true" className="size-4" /> : null}</button> : null}</div>; })}</div> : <div className="h-[330px] w-full overflow-x-auto rounded-xl border border-border bg-surface" data-pipeline-graph><div className="h-full min-w-[2400px]"><ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} defaultViewport={{ x: 20, y: 0, zoom: 1 }} minZoom={0.55} maxZoom={1} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }} /></div></div>}
    <Sheet open={!!infoStep} onOpenChange={(open) => !open && setInfoStep(null)}><SheetContent className="w-full max-md:!w-full overflow-y-auto sm:max-w-md max-md:[&>button]:min-h-(--control-h-touch) max-md:[&>button]:min-w-(--control-h-touch)"><SheetHeader><SheetTitle>{infoStep && t(`pipeline.step.${infoStep}`)}</SheetTitle><SheetDescription>{t("pipeline.automaticStep")}</SheetDescription></SheetHeader><div className="space-y-3 p-4 text-sm"><p>{t("pipeline.noGate")}</p>{infoStep ? modelEditor(infoStep) : null}</div></SheetContent></Sheet>
    <ErrorNote error={router.error ?? policy.error ?? history.error ?? featureHistory.error ?? action.error} />
    <Sheet open={!!editGate} onOpenChange={(open) => !open && setEditGate(null)}><SheetContent className="w-full max-md:!w-full overflow-y-auto sm:max-w-md max-md:[&_button]:min-h-(--control-h-touch) max-md:[&_input:not([type=checkbox])]:min-h-(--control-h-touch) max-md:[&_input[type=checkbox]]:min-h-0 max-md:[&>button]:min-w-(--control-h-touch)" data-pipeline-editor><SheetHeader><SheetTitle>{editGate && t(`sdlc.gate.${editGate}`)}</SheetTitle><SheetDescription>{editGate && t(`sdlc.gateHint.${editGate}`)}</SheetDescription></SheetHeader>{editGate ? <div className="space-y-5 p-4"><div className="space-y-2">{GATE_MODES.map((mode) => { const locked = !!ceiling && !modeWithinCeiling(mode, ceiling[editGate]); return <button key={mode} className={`flex min-h-(--control-h-touch) w-full items-center gap-3 rounded-lg border p-3 text-left ${draftMode === mode ? "border-primary bg-selected" : "border-border"}`} disabled={!editable || locked} onClick={() => setDraftMode(mode)} aria-pressed={draftMode === mode} data-pipeline-mode={mode}><span>{t(`sdlc.mode.${mode}`)}</span><span className="text-xs text-muted-foreground">{t(`sdlc.modeHint.${mode}`)}</span>{locked ? <span className="ml-auto flex items-center gap-1 text-xs text-warning"><LockKeyhole aria-hidden="true" className="size-4 shrink-0" />{t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling![editGate]}`) })}</span> : null}</button>; })}</div><p className="text-sm text-muted-foreground">{t("pipeline.approver", { role: editGate === "review" || editGate === "merge" ? t("pipeline.reviewer") : t("pipeline.manager") })}</p>{editGate === "fix" ? <label className="block text-sm">{t("sdlc.maxFixRounds")}<Input className="mt-1 min-h-(--control-h-touch) text-base" type="number" min={0} max={5} value={fixRounds} onChange={(e) => setFixRounds(e.target.value)} data-pipeline-fix /></label> : null}{editGate === "dispatch" ? <label className="block text-sm">{t("sdlc.maxParallel")}<Input className="mt-1 min-h-(--control-h-touch) text-base" type="number" min={1} max={20} placeholder="∞" value={parallel} onChange={(e) => setParallel(e.target.value)} data-pipeline-parallel /></label> : null}{modelEditor(editGate)}<Button className="min-h-(--control-h-touch)" disabled={!editable || action.busy || !fixRounds || !Number.isInteger(Number(fixRounds)) || Number(fixRounds) < 0 || Number(fixRounds) > 5 || (parallel !== "" && (!Number.isInteger(Number(parallel)) || Number(parallel) < 1 || Number(parallel) > 20))} onClick={() => save({ ...current?.gates, [editGate]: draftMode })} data-pipeline-save>{t("sdlc.save")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
    <Sheet open={!!preset} onOpenChange={(open) => !open && setPreset(null)}><SheetContent className="w-full max-md:!w-full overflow-y-auto sm:max-w-md max-md:[&_button]:min-h-(--control-h-touch) max-md:[&_input:not([type=checkbox])]:min-h-(--control-h-touch) max-md:[&_input[type=checkbox]]:min-h-0 max-md:[&>button]:min-w-(--control-h-touch)" data-pipeline-preview><SheetHeader><SheetTitle>{preset && t(`pipeline.preset.${preset}`)}</SheetTitle><SheetDescription>{t("pipeline.preview")}</SheetDescription></SheetHeader>{preset && ceiling ? <div className="space-y-4 p-4"><div className="space-y-2">{SDLC_GATES.map((g) => { const next = presetGates(preset, ceiling, current?.effective)[g]; return <div key={g} className="flex justify-between gap-2 border-b border-border py-2 text-sm" data-pipeline-change={g}><span>{t(`sdlc.gate.${g}`)}</span><span>{t(`sdlc.mode.${effective(g)}`)} → {t(`sdlc.mode.${next}`)}</span></div>; })}</div><div className="text-sm" data-pipeline-fast-change>{t("pipeline.fastKinds", { kinds: (current?.fastLaneKinds ?? []).map((kind) => t(`taskClass.kindValues.${kind}`)).join(" · ") || "—" })} → {preset === "fast" ? fastKinds.map((kind) => t(`taskClass.kindValues.${kind}`)).join(" · ") || "—" : "—"}</div>{preset === "fast" ? <fieldset className="space-y-2"><legend className="text-sm">{t("pipeline.fastSelect")}</legend>{FAST_KINDS.map((kind) => <label key={kind} className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={fastKinds.includes(kind)} onChange={(e) => setFastKinds((old) => e.target.checked ? [...old, kind] : old.filter((k) => k !== kind))} data-pipeline-fast-kind={kind} />{t(`taskClass.kindValues.${kind}`)}</label>)}</fieldset> : null}<p className="text-sm text-muted-foreground" data-pipeline-model-change>{t("modelRouting.profile")}: {t(`modelRouting.${router.data?.projects[project]?.profile ?? "balanced"}`)} → {t(`modelRouting.${presetModelProfile(preset) ?? router.data?.projects[project]?.profile ?? "balanced"}`)}</p><Button className="min-h-(--control-h-touch)" disabled={!editable || action.busy} onClick={() => save(presetGates(preset, ceiling, current?.effective), current?.maxFixRounds ?? 2, current?.maxParallel ?? null, preset === "fast" ? fastKinds : [])} data-pipeline-apply>{t("pipeline.apply")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
    </>}
  </Page>;
}
