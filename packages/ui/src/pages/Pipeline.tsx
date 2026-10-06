import { useMemo, useState } from "react";
import { ReactFlow, Handle, Position, type Node, type NodeProps, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { ArrowRight, Bot, LockKeyhole, UserRound } from "lucide-react";
import { GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { useAction, useCan, useHashParam, useHive, usePoll, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useIsMobile } from "#ui/lib/hooks/use-mobile.ts";
import { scopeProject } from "#ui/lib/scope.ts";
import { FAST_KINDS, PIPELINE_PRESETS, PIPELINE_STEPS, flowStep, gateMetrics, modeWithinCeiling, presetGates, stepCounts, type PipelinePreset, type PipelineStep } from "#ui/lib/pipeline.ts";

type StepData = Record<string, unknown> & { step: PipelineStep; count: number; median: number | null; pass: number | null; active: boolean; onOpen: (step: PipelineStep) => void; onCount: (step: PipelineStep) => void; label: string; countLabel: string; waitLabel: string; passLabel: string; modelLabel: string; roleLabel: string };
type GateData = Record<string, unknown> & { gate: SdlcGate; mode: GateMode; locked: boolean; onOpen: (gate: SdlcGate) => void; label: string };
function StepNode({ data }: NodeProps<Node<StepData>>) {
  return <><Handle type="target" position={Position.Left} isConnectable={false} /><div className={`rounded-xl border bg-card p-3 shadow-sm ${data.active ? "border-primary ring-2 ring-primary/30" : "border-border"}`} data-pipeline-step={data.step} data-active={data.active}>
    <button className="nodrag min-h-11 w-full text-left font-semibold text-fg-strong" onClick={() => data.onOpen(data.step)}>{data.label}</button><div className="text-xs text-muted-foreground">{data.roleLabel}</div>
    <a className="nodrag block min-h-11 text-sm text-fg-link underline underline-offset-2" href="#" onClick={(e) => { e.preventDefault(); data.onCount(data.step); }} data-pipeline-count={data.step}>{data.countLabel.replace("{count}", String(data.count))}</a>
    <div className="space-y-1 text-xs text-muted-foreground"><div>{data.waitLabel}: {data.median === null ? "—" : `${Math.round(data.median * 10) / 10}h`}</div><div>{data.passLabel}: {data.pass === null ? "—" : `${data.pass}%`}</div><div>{data.modelLabel}</div></div>
  </div><Handle type="source" position={Position.Right} isConnectable={false} /></>;
}
const MODE_ICON = { human: UserRound, ai: Bot, auto: ArrowRight };
function GateNode({ data }: NodeProps<Node<GateData>>) {
  const Icon = MODE_ICON[data.mode];
  return <><Handle type="target" position={Position.Left} isConnectable={false} /><button className="nodrag flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-fg-strong shadow-sm" aria-label={data.label} title={data.label} onClick={() => data.onOpen(data.gate)} data-pipeline-gate={data.gate}><Icon className="size-4" />{data.locked ? <LockKeyhole className="ml-0.5 size-3 text-warning" /> : null}</button><Handle type="source" position={Position.Right} isConnectable={false} /></>;
}
const NODE_TYPES = { step: StepNode, gate: GateNode };
const STEP_GATE: Partial<Record<PipelineStep, SdlcGate>> = { spec: "spec", plan: "plan", tasks: "tasks", dispatch: "dispatch", review: "review", fix: "fix", merge: "merge" };

export function PipelinePage() {
  const { client, scope, setScope } = useHive();
  const projects = useProjects();
  const t = useT();
  const can = useCan();
  const mobile = useIsMobile();
  const poll = usePoll(15000);
  const [linkedProject] = useHashParam("project");
  const [linkedFlow] = useHashParam("flow");
  const [selectedProject, setSelectedProject] = useState("");
  const project = (linkedProject && projects.includes(linkedProject) ? linkedProject : selectedProject || scopeProject(scope) || projects[0]) ?? "";
  const [editGate, setEditGate] = useState<SdlcGate | null>(null);
  const [draftMode, setDraftMode] = useState<GateMode>("human");
  const [fixRounds, setFixRounds] = useState("2");
  const [parallel, setParallel] = useState("");
  const [preset, setPreset] = useState<PipelinePreset | null>(null);
  const [focusFlow, setFocusFlow] = useState("");
  const [tick, setTick] = useState(0);
  const action = useAction();
  const policy = useQuery(() => client.call("sdlc.get", {}), [client, tick]);
  const history = useQuery(async () => {
    if (!project) return { flows: [], tasks: [], gates: [], work: [] };
    const [flows, tasks, gates, work] = await Promise.all([
      client.call("sdlc.flows", { project, limit: 200 }),
      client.call("sdlc.flowTasks", { project }),
      client.call("sdlc.gates", { project, limit: 200 }),
      client.call("tasks.list", { project }),
    ]);
    return { flows, tasks, gates, work };
  }, [client, project, poll, tick]);
  const current = policy.data?.projects[project];
  const ceiling = policy.data?.ceiling;
  const counts = useMemo(() => {
    const next = stepCounts(history.data?.flows ?? [], history.data?.tasks ?? []);
    const owned = new Set([...(history.data?.flows ?? []).map((f) => f.taskId), ...(history.data?.tasks ?? []).map((task) => task.taskId)]);
    next.dispatch += (history.data?.work ?? []).filter((task) => !owned.has(task.id) && task.status !== "done" && current?.fastLaneKinds.includes(task.kind as (typeof FAST_KINDS)[number])).length;
    return next;
  }, [history.data, current]);
  const metrics = useMemo(() => gateMetrics(history.data?.gates ?? []), [history.data]);
  const flow = (history.data?.flows ?? []).find((f) => f.taskId === (focusFlow || linkedFlow));
  const activeStep = flow ? flowStep(flow) : null;
  const passed = new Set((history.data?.gates ?? []).filter((g) => g.taskId === (focusFlow || linkedFlow) && g.status === "passed").map((g) => g.gate));
  const editable = !!project && can(project, "projectSettings");
  const openGate = (gate: SdlcGate) => { setEditGate(gate); setDraftMode(current?.gates[gate] ?? "human"); setFixRounds(String(current?.maxFixRounds ?? 2)); setParallel(current?.maxParallel == null ? "" : String(current.maxParallel)); };
  const openStep = (step: PipelineStep) => { const gate = STEP_GATE[step]; if (gate) openGate(gate); };
  const openCount = (step: PipelineStep) => { if (step === "dispatch" && current?.fastLaneKinds.length) { window.location.hash = `#/tasks?project=${encodeURIComponent(project)}&kind=fast`; return; } const column = step === "build" || step === "dispatch" ? "doing" : step === "fix" || step === "merge" ? "review" : step === "idea" ? "spec" : step; window.location.hash = `#/features?project=${encodeURIComponent(project)}&column=${column}`; };
  const save = (gates: Partial<GateModes>, rounds = Number(fixRounds), maxParallel = parallel ? Number(parallel) : null, fastLaneKinds = current?.fastLaneKinds ?? []) => void action.run(async () => {
    await client.call("sdlc.setProject", { project, settings: { gates, maxFixRounds: rounds, maxParallel, fastLaneKinds } });
    setEditGate(null); setPreset(null); setTick((x) => x + 1);
  });
  const effective = (g: SdlcGate) => current?.effective[g] ?? "human";
  const gateLabel = (g: SdlcGate) => `${t(`sdlc.gate.${g}`)} · ${t(`sdlc.mode.${effective(g)}`)}${ceiling && ceiling[g] !== "auto" ? ` · ${t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling[g]}`) })}` : ""}`;
  const stepData = (step: PipelineStep): StepData => ({ step, count: counts[step], median: STEP_GATE[step] ? metrics[STEP_GATE[step]!].medianHours : null, pass: STEP_GATE[step] ? metrics[STEP_GATE[step]!].firstPass : null, active: activeStep === step, onOpen: openStep, onCount: openCount, label: t(`pipeline.step.${step}`), countLabel: t("pipeline.count"), waitLabel: t("pipeline.wait"), passLabel: t("pipeline.firstPass"), modelLabel: t("pipeline.defaultModel"), roleLabel: STEP_GATE[step] ? t("pipeline.approver", { role: step === "review" || step === "merge" ? t("pipeline.reviewer") : t("pipeline.manager") }) : t("pipeline.automaticStep") });
  const gateData = (gate: SdlcGate): GateData => ({ gate, mode: effective(gate), locked: !!ceiling && ceiling[gate] !== "auto", onOpen: openGate, label: gateLabel(gate) });
  const nodes = useMemo(() => {
    const out: Node[] = [];
    let x = 0;
    PIPELINE_STEPS.forEach((step, i) => {
      out.push({ id: step, type: "step", position: { x, y: 38 }, data: stepData(step), draggable: false, selectable: false, style: { width: 158 } });
      x += 174;
      const gate = STEP_GATE[step];
      if (gate && i < PIPELINE_STEPS.length - 1) { out.push({ id: `gate:${gate}`, type: "gate", position: { x, y: 98 }, data: gateData(gate), draggable: false, selectable: false }); x += 62; }
    });
    return out;
  }, [current, ceiling, counts, metrics, activeStep, project]);
  const edges: Edge[] = nodes.slice(1).map((node, i) => ({ id: `${nodes[i]!.id}-${node.id}`, source: nodes[i]!.id, target: node.id, type: "straight", style: { stroke: "var(--line-strong)" } }));
  if (!project) return <Page><p>{t("pipeline.noProject")}</p></Page>;
  return <Page wide className="min-w-0" >
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold text-fg-strong">{t("pipeline.title")}</h1><p className="text-sm text-muted-foreground">{t("pipeline.intro")}</p></div>
      <label className="flex items-center gap-2 text-sm">{t("pipeline.project")}<select className="min-h-11 rounded-md border border-border bg-card px-3 text-base" value={project} onChange={(e) => { setSelectedProject(e.target.value); setScope({ kind: "project", project: e.target.value }); window.location.hash = `#/pipeline?project=${encodeURIComponent(e.target.value)}`; }} data-pipeline-project>{projects.map((p) => <option key={p}>{p}</option>)}</select></label></div>
    <div className="flex flex-wrap gap-2" aria-label={t("pipeline.presets")}>{PIPELINE_PRESETS.map((p) => <Button key={p} variant="outline" className="max-md:min-h-11" onClick={() => setPreset(p)} data-pipeline-preset={p}>{t(`pipeline.preset.${p}`)}</Button>)}</div>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t("pipeline.feature")}<select className="min-h-11 min-w-48 max-w-full rounded-md border border-border bg-card px-3 text-base" value={focusFlow || linkedFlow || ""} onChange={(e) => setFocusFlow(e.target.value)} data-pipeline-feature><option value="">{t("pipeline.allFeatures")}</option>{(history.data?.flows ?? []).map((f) => <option key={f.taskId} value={f.taskId}>{f.taskId}</option>)}</select></label>
    {mobile ? <div className="flex flex-col gap-2" data-pipeline-mobile>{PIPELINE_STEPS.map((step) => { const d = stepData(step); const gate = STEP_GATE[step]; return <div key={step} className="space-y-2"><div className={`rounded-xl border p-3 ${d.active ? "border-primary bg-selected" : "border-border bg-card"}`} data-pipeline-step={step}><button className="min-h-11 w-full text-left font-semibold" onClick={() => openStep(step)}>{d.label}</button><p className="text-xs text-muted-foreground">{d.roleLabel}</p><button className="min-h-11 text-left text-sm text-fg-link underline" onClick={() => openCount(step)} data-pipeline-count={step}>{t("pipeline.count", { count: d.count })}</button><p className="text-xs text-muted-foreground">{t("pipeline.wait")}: {d.median == null ? "—" : `${Math.round(d.median * 10) / 10}h`} · {t("pipeline.firstPass")}: {d.pass == null ? "—" : `${d.pass}%`} · {d.modelLabel}</p></div>{gate ? <button className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm" onClick={() => openGate(gate)} data-pipeline-gate={gate}>{t(`sdlc.gate.${gate}`)} · {t(`sdlc.mode.${effective(gate)}`)}{ceiling?.[gate] !== "auto" ? <LockKeyhole className="size-4" /> : null}</button> : null}</div>; })}</div> : <div className="h-[330px] w-full overflow-x-auto rounded-xl border border-border bg-surface" data-pipeline-graph><div className="h-full min-w-[2400px]"><ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} defaultViewport={{ x: 20, y: 0, zoom: 1 }} minZoom={0.55} maxZoom={1} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} proOptions={{ hideAttribution: true }} /></div></div>}
    <ErrorNote error={policy.error ?? history.error ?? action.error} />
    <Sheet open={!!editGate} onOpenChange={(open) => !open && setEditGate(null)}><SheetContent className="w-full overflow-y-auto sm:max-w-md" data-pipeline-editor><SheetHeader><SheetTitle>{editGate && t(`sdlc.gate.${editGate}`)}</SheetTitle><SheetDescription>{editGate && t(`sdlc.gateHint.${editGate}`)}</SheetDescription></SheetHeader>{editGate ? <div className="space-y-5 p-4"><div className="space-y-2">{GATE_MODES.map((mode) => { const locked = !!ceiling && !modeWithinCeiling(mode, ceiling[editGate]); return <button key={mode} className={`flex min-h-11 w-full items-center gap-3 rounded-lg border p-3 text-left ${draftMode === mode ? "border-primary bg-selected" : "border-border"}`} disabled={!editable || locked} onClick={() => setDraftMode(mode)} data-pipeline-mode={mode}><span>{t(`sdlc.mode.${mode}`)}</span><span className="text-xs text-muted-foreground">{t(`sdlc.modeHint.${mode}`)}</span>{locked ? <span className="ml-auto flex items-center gap-1 text-xs text-warning"><LockKeyhole className="size-4 shrink-0" />{t("pipeline.ceiling", { mode: t(`sdlc.mode.${ceiling![editGate]}`) })}</span> : null}</button>; })}</div><p className="text-sm text-muted-foreground">{t("pipeline.approver", { role: editGate === "review" || editGate === "merge" ? t("pipeline.reviewer") : t("pipeline.manager") })}</p>{editGate === "fix" ? <label className="block text-sm">{t("sdlc.maxFixRounds")}<Input className="mt-1 min-h-11 text-base" type="number" min={0} max={5} value={fixRounds} onChange={(e) => setFixRounds(e.target.value)} data-pipeline-fix /></label> : null}{editGate === "dispatch" ? <label className="block text-sm">{t("sdlc.maxParallel")}<Input className="mt-1 min-h-11 text-base" type="number" min={1} max={20} placeholder="∞" value={parallel} onChange={(e) => setParallel(e.target.value)} data-pipeline-parallel /></label> : null}<p className="text-sm text-muted-foreground">{t("pipeline.defaultModel")}</p><Button className="min-h-11" disabled={!editable || action.busy || !fixRounds || Number(fixRounds) > 5 || (parallel !== "" && (Number(parallel) < 1 || Number(parallel) > 20))} onClick={() => save({ ...current?.gates, [editGate]: draftMode })} data-pipeline-save>{t("sdlc.save")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
    <Sheet open={!!preset} onOpenChange={(open) => !open && setPreset(null)}><SheetContent className="w-full overflow-y-auto sm:max-w-md" data-pipeline-preview><SheetHeader><SheetTitle>{preset && t(`pipeline.preset.${preset}`)}</SheetTitle><SheetDescription>{t("pipeline.preview")}</SheetDescription></SheetHeader>{preset && ceiling ? <div className="space-y-4 p-4"><div className="space-y-2">{SDLC_GATES.map((g) => { const next = presetGates(preset, ceiling, current?.effective)[g]; return <div key={g} className="flex justify-between gap-2 border-b border-border py-2 text-sm" data-pipeline-change={g}><span>{t(`sdlc.gate.${g}`)}</span><span>{t(`sdlc.mode.${effective(g)}`)} → {t(`sdlc.mode.${next}`)}</span></div>; })}</div>{preset === "fast" ? <p className="text-sm">{t("pipeline.fastKinds", { kinds: FAST_KINDS.join(" · ") })}</p> : null}<p className="text-sm text-muted-foreground">{t("pipeline.defaultModel")}</p><Button className="min-h-11" disabled={!editable || action.busy} onClick={() => save(presetGates(preset, ceiling, current?.effective), current?.maxFixRounds ?? 2, current?.maxParallel ?? null, preset === "fast" ? [...FAST_KINDS] : [])} data-pipeline-apply>{t("pipeline.apply")}</Button><ErrorNote error={action.error} /></div> : null}</SheetContent></Sheet>
  </Page>;
}
