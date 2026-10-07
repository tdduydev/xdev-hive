import { useState } from "react";
import type { DesktopProject } from "@xdev-hive/core";
import { useHive, useAction } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Button } from "@xdev-hive/ui/components/ui/button";

export function ProjectRelease({ project, onSaved }: { project: DesktopProject; onSaved: () => void }) {
  const { client } = useHive(); const t = useT(); const action = useAction();
  const keys = ["prepare", "release", "deploy", "checkLogs"] as const;
  const [draft, setDraft] = useState(() => Object.fromEntries(keys.map(k => [k, project.autoRelease?.[k] ? JSON.stringify(project.autoRelease[k]) : ""])) as Record<typeof keys[number], string>);
  const [rollout, setRollout] = useState(project.autoRelease?.appRollout ?? false);
  return <details data-release-config={project.name} className="border-t border-dashed pt-3"><summary className="min-h-(--control-h-touch) cursor-pointer text-sm font-semibold">{t("autoRelease.title")}</summary><form className="space-y-3 py-3" onSubmit={e => { e.preventDefault(); void action.run(async () => {
    const command = (key: typeof keys[number]) => {
      if (!draft[key].trim() && (key === "deploy" || key === "checkLogs")) return undefined;
      let value: unknown; try { value = JSON.parse(draft[key]); } catch { throw new Error(t("autoRelease.invalid")); }
      if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string" || !v)) throw new Error(t("autoRelease.invalid"));
      return value as string[];
    };
    await client.desktop!.updateProject(project.name, { autoRelease: { prepare: command("prepare")!, release: command("release")!, deploy: command("deploy"), checkLogs: command("checkLogs"), appRollout: rollout, timeoutMinutes: project.autoRelease?.timeoutMinutes ?? 60 } }); onSaved();
  }); }}><p className="text-sm text-muted-foreground">{t("autoRelease.local")}</p><p className="text-sm text-muted-foreground">{t("autoRelease.hint")}</p>{keys.map(key => <label key={key} className="block text-sm">{t(`autoRelease.${key}`)}<Input className="mt-1 min-h-(--control-h-touch) text-base font-mono" value={draft[key]} onChange={e => setDraft(old => ({ ...old, [key]: e.target.value }))} data-release-command={key} /></label>)}<label className="flex min-h-(--control-h-touch) items-center gap-2 text-sm"><input type="checkbox" checked={rollout} onChange={e => setRollout(e.target.checked)} />{t("autoRelease.appRollout")}</label><div className="flex flex-wrap gap-2"><Button className="min-h-(--control-h-touch)" disabled={action.busy} type="submit">{t("autoRelease.save")}</Button><Button className="min-h-(--control-h-touch)" variant="outline" disabled={action.busy} type="button" onClick={() => void action.run(async () => { await client.desktop!.updateProject(project.name, { autoRelease: null }); onSaved(); })}>{t("autoRelease.disable")}</Button></div><ErrorNote error={action.error} /></form></details>;
}
