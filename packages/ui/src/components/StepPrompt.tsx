// The Prompt tab of a gate's panel (roadmap 72i): what the project's manager wants every run of this step to know,
// kept in versions. Saving takes contextEdit (agents read it); anyone who can see the project reads it.
import { useEffect, useState } from "react";
import { STEP_PROMPT_MAX, type SdlcGate } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function StepPromptPanel({ project, step }: { project: string; step: SdlcGate }) {
  const { client } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const prompts = useQuery(() => client.call("sdlc.prompts", { project }), [client, project, tick]);
  const history = useQuery(() => client.call("sdlc.promptHistory", { project, step }), [client, project, step, tick]);
  const saved = prompts.data?.find((p) => p.step === step);
  const editable = can(project, "contextEdit");
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  // The text on the hub is the draft's start; a newer version (a save of mine, or a reload) replaces what was typed.
  useEffect(() => { if (saved) setDraft(saved.text); }, [saved?.version, saved?.text]);
  const changes = saved && draft.trim() !== saved.text ? 1 : 0;
  const shown = history.data?.find((v) => v.version === viewing);
  const save = () => saved && void action.run(async () => {
    await client.call("sdlc.setPrompt", { project, step, text: draft, baseVersion: saved.version });
    setDone(true); setTick((x) => x + 1);
  });
  const stepName = t(`sdlc.gate.${step}`);
  return <div className="pf-prompt" data-step-prompt={step}>
    <p className="pf-cap m-0">{t("stepPrompt.hint", { step: stepName })}</p>
    {!editable ? <p className="pf-cap m-0" data-step-prompt-readonly>{t("stepPrompt.readOnly")}</p> : null}
    <label className="pf-label" htmlFor={`pf-prompt-${step}`}>{t("stepPrompt.label", { step: stepName })}</label>
    <Textarea id={`pf-prompt-${step}`} className="pf-prompt-text" rows={8} maxLength={STEP_PROMPT_MAX} value={draft} readOnly={!editable} placeholder={t("stepPrompt.placeholder")}
      onChange={(e) => { setDraft(e.target.value); setDone(false); }} data-step-prompt-text />
    <div className="pf-prompt-meta">
      <span className="pf-cap" data-step-prompt-count>{t("stepPrompt.count", { used: draft.length, max: STEP_PROMPT_MAX })}</span>
      <span className="pf-spacer" />
      <span className="pf-cap" data-step-prompt-version>{saved?.version ? `${t("stepPrompt.version", { version: saved.version })} · ${t("stepPrompt.updated", { by: saved.updatedBy ?? "", at: formatTime(saved.updatedAt) })}` : t("stepPrompt.none")}</span>
    </div>
    {editable ? <div className="pf-unsaved" role="status" data-step-prompt-unsaved={changes}>
      <span>{changes ? t("pipeline.unsaved", { count: changes }) : done ? t("stepPrompt.saved") : t("pipeline.noChanges")}</span><span className="pf-spacer" />
      <Button size="sm" variant="ghost" disabled={!changes || action.busy} onClick={() => { setDraft(saved?.text ?? ""); setDone(false); }} data-step-prompt-cancel>{t("pipeline.cancel")}</Button>
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
          {editable ? <Button size="sm" variant="glass" onClick={() => { setDraft(shown.text); setDone(false); setViewing(null); }} data-prompt-version-load>{t("stepPrompt.load")}</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>{t("stepPrompt.close")}</Button>
        </div>
      </div> : null}
    </div>
  </div>;
}
