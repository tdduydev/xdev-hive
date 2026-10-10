// The Prompt tab of the pipeline page (roadmap 72i): what a run is told, layer by layer, in the order the runner puts it
// together. Only the step's layer is the project's manager's to write (kept in versions, saved with contextEdit; anyone
// who can see the project reads it); the rest is Hive's and shows what the agent will be told. The last column is the
// prompt as a sample task would get it, built by the same code as the runner's (core/prompt-layers.ts).
import { useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { PROMPT_LAYERS, PROMPT_ROLES, PROMPT_ROLES_WIRED, STEP_PROMPT_MAX, STEP_PROMPT_VARS, promptPreview, type PromptLayerId, type PromptRole, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Tag } from "@xdev-hive/ui/components/ui/primitives";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { shortAgo } from "#ui/lib/inbox.ts";

const SAMPLE_TASKS = 3;
// One colour per layer, shared by the layer's swatch, the bar beside its words in the final prompt and the legend.
const LAYER_COLOR: Record<PromptLayerId, string> = {
  frame: "var(--accent-blue)",
  repo: "var(--accent-green)",
  artifacts: "var(--text-faint)",
  task: "var(--text-muted)",
  step: "var(--accent-violet)",
  admin: "color-mix(in srgb, var(--accent-red) 55%, var(--accent-green))",
  steer: "var(--border-strong)",
};

export function PromptTab({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const editable = can(project, "contextEdit");
  const [role, setRole] = useState<PromptRole>("implement");
  const [stepOf, setStepOf] = useState<Partial<Record<PromptRole, SdlcGate>>>({});
  const [open, setOpen] = useState<Partial<Record<PromptLayerId, boolean>>>({ step: true });
  // A draft is kept per step, so going to another role and back does not lose what was typed.
  const [drafts, setDrafts] = useState<Partial<Record<SdlcGate, string>>>({});
  const [tick, setTick] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const roleDef = PROMPT_ROLES.find((r) => r.role === role)!;
  const steps: readonly SdlcGate[] = roleDef.steps;
  const step: SdlcGate | null = steps.length ? (stepOf[role] ?? steps[0]!) : null;

  const prompts = useQuery(() => client.call("sdlc.prompts", { project }), [client, project, tick]);
  const history = useQuery(() => step ? client.call("sdlc.promptHistory", { project, step }) : Promise.resolve([]), [client, project, step, tick]);
  const tasks = useQuery(() => client.call("tasks.list", { project }), [client, project]);
  const saved = step ? prompts.data?.find((p) => p.step === step) : undefined;
  const hasPrompt = (r: (typeof PROMPT_ROLES)[number]) => r.steps.some((s) => !!prompts.data?.find((p) => p.step === s)?.text);

  const samples = useMemo(() => [...(tasks.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, SAMPLE_TASKS).map((x) => ({ id: x.id, title: x.title, note: x.note })), [tasks.data]);
  const sample = samples.find((s) => s.id === sampleId) ?? samples[0] ?? { id: "T-123", title: t("stepPrompt.sampleTitle"), note: null };

  const draft = step ? (drafts[step] ?? saved?.text ?? "") : "";
  const changes = step && saved && draft.trim() !== saved.text ? 1 : 0;
  const setDraft = (text: string | undefined) => { if (step) { setDrafts((d) => ({ ...d, [step]: text })); setDone(false); } };
  const shown = history.data?.find((v) => v.version === viewing);
  const save = () => step && saved && void action.run(async () => {
    await client.call("sdlc.setPrompt", { project, step, text: draft, baseVersion: saved.version });
    setDraft(undefined); setDone(true); setTick((x) => x + 1);
  });
  const insert = (v: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? at;
    const next = draft.slice(0, at) + v + draft.slice(end);
    if (next.length > STEP_PROMPT_MAX) return;
    setDraft(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + v.length, at + v.length); });
  };

  const layers = promptPreview({ role, project, task: sample, branch: `ai/${sample.id}`, step: step ? { step, version: saved?.version ?? 0, text: draft } : null });
  const stepName = step ? t(`sdlc.gate.${step}`) : "";
  const placeholder: Partial<Record<PromptLayerId, string>> = { repo: t("stepPrompt.repoSample"), admin: t("stepPrompt.adminSample") };
  const segs = (layers ?? []).flatMap((l) => l.text === "" ? [] : [{ id: l.id, text: l.text ?? placeholder[l.id] ?? "", real: l.text !== null }]);
  const chars = segs.filter((s) => s.real).reduce((n, s) => n + s.text.length, 0) + Math.max(0, segs.filter((s) => s.real).length - 1) * 2;
  const skipped = layers?.find((l) => l.id === "step")?.skipped;
  const now = Date.now();
  const meta = (id: PromptLayerId): string => {
    if (id !== "step") return t("stepPrompt.locked");
    if (!saved?.version) return t("stepPrompt.none");
    return `v${saved.version} · ${saved.updatedBy ?? ""} · ${saved.updatedAt ? t("inbox.agoLong", { when: shortAgo(saved.updatedAt, now, t) }) : ""}`;
  };

  const stepBody = step ? <>
    {steps.length > 1 ? <div className="pf-prompt-steps" role="group" aria-label={t("stepPrompt.stepsLabel")} data-step-prompt-steps>
      <span className="pf-cap">{t("stepPrompt.stepsLabel")}</span>
      {steps.map((s) => <button key={s} type="button" className="pf-tagbtn" aria-pressed={s === step} onClick={() => { setStepOf((o) => ({ ...o, [role]: s })); setViewing(null); setDone(false); }} data-step-prompt-pick={s}><Tag active={s === step}>{t(`sdlc.gate.${s}`)}</Tag></button>)}
    </div> : null}
    <p className="pf-cap m-0">{t("stepPrompt.hint", { step: stepName })} {t("stepPrompt.saveBy", { step: stepName })}</p>
    {!editable ? <p className="pf-cap m-0" data-step-prompt-readonly>{t("stepPrompt.readOnly")}</p> : null}
    {!PROMPT_ROLES_WIRED.includes(role) ? <p className="pf-cap m-0" data-step-prompt-unwired>{t("stepPrompt.notWired")}</p> : null}
    <label className="pf-label" htmlFor={`pf-prompt-${step}`}>{t("stepPrompt.label", { step: stepName })}</label>
    <Textarea ref={area} id={`pf-prompt-${step}`} className="pf-prompt-text" rows={8} maxLength={STEP_PROMPT_MAX} value={draft} readOnly={!editable} placeholder={t("stepPrompt.placeholder")}
      onChange={(e) => setDraft(e.target.value)} data-step-prompt-text />
    <div className="pf-prompt-vars">
      <span className="pf-cap">{t("stepPrompt.insertVar")}</span>
      {editable ? STEP_PROMPT_VARS.map((v) => <button key={v} type="button" className="pf-var" onClick={() => insert(v)} data-step-prompt-var={v}>{v}</button>) : null}
      <span className="pf-spacer" />
      <span className="pf-cap" data-step-prompt-count>{t("stepPrompt.count", { used: draft.length, max: STEP_PROMPT_MAX })}</span>
      <span className="pf-cap" data-step-prompt-version>{saved?.version ? `${t("stepPrompt.version", { version: saved.version })} · ${t("stepPrompt.updated", { by: saved.updatedBy ?? "", at: formatTime(saved.updatedAt) })}` : t("stepPrompt.none")}</span>
    </div>
    {skipped ? <p className="pf-cap m-0" role="alert" data-step-prompt-skipped>{t("stepPrompt.skipped", { why: skipped })}</p> : null}
    {editable ? <div className="pf-unsaved" role="status" data-step-prompt-unsaved={changes}>
      <span>{changes ? t("pipeline.unsaved", { count: changes }) : done ? t("stepPrompt.saved") : t("pipeline.noChanges")}</span><span className="pf-spacer" />
      <Button size="sm" variant="ghost" disabled={!changes || action.busy} onClick={() => setDraft(undefined)} data-step-prompt-cancel>{t("pipeline.cancel")}</Button>
      <Button size="sm" variant="solid" disabled={!changes || action.busy} onClick={save} data-step-prompt-save>{t("sdlc.save")}</Button>
    </div> : null}
    <ErrorNote error={action.error ?? prompts.error ?? history.error} />
    <div className="pf-group" data-step-prompt-history>
      <span className="pf-label">{t("stepPrompt.history")}</span>
      {history.data?.length ? history.data.map((v) => <div key={v.version} className="pf-item" data-prompt-version={v.version}>
        <code>v{v.version}</code><span>{t("stepPrompt.updated", { by: v.by, at: formatTime(v.at) })}</span>
        <Button size="sm" variant="ghost" aria-pressed={viewing === v.version} onClick={() => setViewing(viewing === v.version ? null : v.version)} data-prompt-version-view={v.version}>{t("stepPrompt.view")}</Button>
      </div>) : <span className="pf-empty">{t("stepPrompt.historyEmpty")}</span>}
      {shown ? <div className="pf-prompt-old" data-prompt-version-text>
        <span className="pf-cap">{t("stepPrompt.viewing", { version: shown.version })}</span>
        <pre>{shown.text || t("stepPrompt.cleared")}</pre>
        <div className="pf-prompt-actions">
          {editable ? <Button size="sm" variant="glass" onClick={() => { setDraft(shown.text); setViewing(null); }} data-prompt-version-load>{t("stepPrompt.load")}</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>{t("stepPrompt.close")}</Button>
        </div>
      </div> : null}
    </div>
  </> : null;

  return <div className="pf-prompt" data-step-prompt={step ?? role}>
    <div className="pf-prompt-roles" role="group" aria-label={t("stepPrompt.roles")} data-prompt-roles>
      <span className="pf-micro">{t("stepPrompt.roles")}</span>
      {PROMPT_ROLES.map((r) => <button key={r.role} type="button" className="pf-role" aria-pressed={r.role === role} onClick={() => { setRole(r.role); setViewing(null); }} data-prompt-role={r.role}>
        <span className="pf-role-head"><span>{t(`stepPrompt.role.${r.role}.label`)}</span>{hasPrompt(r) ? <span className="pf-role-custom" data-prompt-role-custom>{t("stepPrompt.custom")}</span> : null}</span>
        <span className="pf-cap">{t(`stepPrompt.role.${r.role}.hint`)}</span>
      </button>)}
    </div>
    <div className="pf-prompt-layers">
      <span className="pf-prompt-intro">{t("stepPrompt.intro")}</span>
      {layers ? layers.map((l) => {
        const isStep = l.id === "step";
        const isOpen = !!open[l.id];
        const label = t(`stepPrompt.layer.${l.id}.label`, { step: stepName });
        return <div key={l.id} className="pf-layer" data-prompt-layer={l.id} data-open={isOpen}>
          <button type="button" className="pf-layer-head" aria-expanded={isOpen} aria-label={t(isOpen ? "stepPrompt.closeLayer" : "stepPrompt.openLayer", { layer: label })} onClick={() => setOpen((o) => ({ ...o, [l.id]: !o[l.id] }))}>
            <span className="pf-swatch" style={{ background: LAYER_COLOR[l.id] }} />
            <span className="pf-layer-text"><span className="pf-layer-label">{label}</span><span className="pf-cap">{t(`stepPrompt.layer.${l.id}.hint`)}</span></span>
            <span className="pf-micro-meta">{meta(l.id)}</span>
            <ChevronDown aria-hidden="true" className="pf-chev" />
          </button>
          {isOpen ? <div className="pf-layer-body">{isStep ? stepBody : <pre className="pf-layer-pre">{l.text ?? placeholder[l.id] ?? ""}{l.text === "" ? t("stepPrompt.noneLayer") : ""}</pre>}</div> : null}
        </div>;
      }) : <div className="pf-layer" data-prompt-layer="none"><div className="pf-layer-body pf-layer-solo"><p className="pf-cap m-0" data-prompt-nostep>{t("stepPrompt.noStepPrompt")}</p></div></div>}
    </div>
    <div className="pf-final" data-prompt-final>
      <div className="pf-final-head">
        <span className="pf-final-title"><b>{t("stepPrompt.final")}</b><span className="pf-cap" data-prompt-final-meta>{layers ? t("stepPrompt.finalMeta", { chars, layers: segs.length }) : "—"}</span></span>
        <div className="pf-final-tasks" role="group" aria-label={t("stepPrompt.sampleTask")}>
          {samples.length ? samples.map((s) => <button key={s.id} type="button" className="pf-tagbtn" aria-pressed={s.id === sample.id} onClick={() => setSampleId(s.id)} data-prompt-sample={s.id}><Tag active={s.id === sample.id}>{s.id}</Tag></button>) : <Tag active>{sample.id}</Tag>}
        </div>
      </div>
      <div className="pf-final-body" data-prompt-final-text>
        {segs.map((s) => <div key={s.id} className="pf-seg"><span className="pf-seg-bar" style={{ background: LAYER_COLOR[s.id] }} /><span className="pf-seg-text" data-real={s.real}>{s.text}</span></div>)}
        {!layers ? <div className="pf-seg"><span className="pf-seg-bar" /><span className="pf-seg-text" data-real="false">{t("stepPrompt.noStepPrompt")}</span></div> : null}
      </div>
      <div className="pf-final-legend">
        {PROMPT_LAYERS.map((id) => <span key={id}><span className="pf-swatch pf-swatch-sm" style={{ background: LAYER_COLOR[id] }} />{t(`stepPrompt.layer.${id}.short`)}</span>)}
      </div>
    </div>
  </div>;
}
