import { ArtifactRows, useArtifacts } from "#ui/components/Artifacts.tsx";
import { useState } from "react";
import type { MergeQueueConfig } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { useHive, useQuery, usePoll, useCan, useAction } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
export function MergeQueue({
  project
}: {
  project?: string | null;
}) {
  const {
    projects,
    scope
  } = useHive();
  const t = useT();
  const [chosen, setChosen] = useState("");
  const available = scope.kind === "system" ? scope.projects : scope.kind === "shared" ? [] : projects;
  const selected = project || (scope.kind === "project" ? scope.project : available.includes(chosen) ? chosen : "");
  return <details className="rounded-lg border border-border bg-surface p-3 text-sm" data-merge-queue>
    <summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:focus-ring">{t("mergeQueue.title")}</summary>
    {!project && scope.kind !== "project" ? <label className="my-2 flex flex-col gap-2">{t("mergeQueue.service")}
      <NativeSelect className="min-h-11 max-md:text-base" value={selected} onChange={e => setChosen(e.target.value)}>
        <NativeSelectOption value="">{t("mergeQueue.select")}</NativeSelectOption>
        {available.map(p => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
      </NativeSelect>
    </label> : null}
    {selected ? <Queue key={selected} project={selected} /> : null}
  </details>;
}
function Queue({
  project
}: {
  project: string;
}) {
  const {
    client
  } = useHive();
  const t = useT();
  const can = useCan();
  const tick = usePoll(5000);
  const action = useAction();
  const query = useQuery(() => client.call("mergeQueue.get", {
    project
  }), [client, project, tick]);
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const [draft, setDraft] = useState<MergeQueueConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? query.data?.config;
  const set = (patch: Partial<MergeQueueConfig>) => {
    setDraft({
      ...value!,
      ...patch
    });
    setSaved(false);
  };
  return <div className="space-y-3 pt-2">
    <ErrorNote error={query.error ?? action.error} />
    {query.data ? <>
      <p>{!query.data.config.enabled ? `${t("mergeQueue.off")} · ` : ""}{t("mergeQueue.waiting", {
          count: query.data.waiting.length
        })}</p>
      {query.data.waiting.length ? <ul className="space-y-1">{query.data.waiting.map(i => <li key={i.taskId} className="break-all">{i.taskId} · {i.branch}</li>)}</ul> : <p className="text-muted-foreground">{t("mergeQueue.empty")}</p>}
      {query.data.batches.slice(0, 5).map(b => <div key={b.id} className="space-y-2 rounded-md border border-border p-2">
        <p className="break-words">#{b.id} · {t(`mergeQueue.${b.status}`)}</p>
        <p className="break-all text-xs text-muted-foreground">{b.step}</p>
        {b.result?.outcomes.filter(o => o.status === "conflict").map(o => <p key={o.taskId} className="break-words">{t("mergeQueue.excluded")}: {o.taskId} — {o.reason}</p>)}
        {b.result?.url ? <a href={b.result.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">MR/PR</a> : null}
        {b.log ? <details><summary className="min-h-11 cursor-pointer content-center focus-visible:focus-ring">{t("mergeQueue.log")}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{b.log}</pre><MergeArtifacts project={project} runId={`MERGE-${b.id}`} machineId={b.machineId} /></details> : null}
      </div>)}
    </> : null}
    {value && can(project, "projectSettings") ? <details>
      <summary className="min-h-11 cursor-pointer content-center focus-visible:focus-ring">{t("mergeQueue.settings")}</summary>
      <form className="space-y-3 pt-2" onSubmit={e => {
        e.preventDefault();
        void action.run(async () => {
          await client.call("mergeQueue.configure", {
            project,
            config: {
              ...value,
              commands: value.commands.map(c => c.trim()).filter(Boolean)
            }
          });
          setSaved(true);
          query.reload();
        });
      }}>
        <label className="flex min-h-11 items-center gap-3"><Switch checked={value.enabled} onCheckedChange={enabled => set({
            enabled
          })} aria-label={t("mergeQueue.enabled")} />{t("mergeQueue.enabled")}</label>
        <label className="flex flex-col gap-2">{t("mergeQueue.machine")}<NativeSelect data-merge-machine className="min-h-11 max-md:text-base" value={value.machineId ?? ""} onChange={e => set({
            machineId: e.target.value || null
          })}>
          <NativeSelectOption value="">{t("mergeQueue.choose")}</NativeSelectOption>
          {(machines.data ?? []).filter(m => m.projects.includes(project)).map(m => <NativeSelectOption key={m.id} value={m.id}>{m.machine}{m.gateRunner ? ` · ${t("mergeQueue.role")}` : ""}</NativeSelectOption>)}
        </NativeSelect></label>
        <label className="flex flex-col gap-2">{t("mergeQueue.target")}<Input className="min-h-11 max-md:text-base" required value={value.target} onChange={e => set({
            target: e.target.value
          })} /></label>
        <label className="flex flex-col gap-2">{t("mergeQueue.max")}<Input className="min-h-11 max-md:text-base" data-merge-max inputMode="numeric" type="number" min={1} max={20} required value={value.maxBranches} onChange={e => set({
            maxBranches: Number(e.target.value)
          })} /></label>
        <label className="flex flex-col gap-2">{t("mergeQueue.wait")}<Input className="min-h-11 max-md:text-base" data-merge-wait inputMode="numeric" type="number" min={0} max={120} required value={value.waitMinutes} onChange={e => set({
            waitMinutes: Number(e.target.value)
          })} /></label>
        <label className="flex flex-col gap-2">{t("mergeQueue.commands")}<Textarea data-merge-commands className="min-h-24 max-md:text-base" value={value.commands.join("\n")} onChange={e => set({
            commands: e.target.value.split("\n")
          })} /></label>
        <p className="text-xs text-muted-foreground">{t("mergeQueue.commandHint")}</p>
        <label className="flex flex-col gap-2">{t("mergeQueue.mode")}<NativeSelect data-merge-mode className="min-h-11 max-md:text-base" value={value.mode} onChange={e => set({
            mode: e.target.value as "mr" | "push"
          })}>
          <NativeSelectOption value="mr">{t("mergeQueue.mr")}</NativeSelectOption><NativeSelectOption value="push">{t("mergeQueue.push")}</NativeSelectOption>
        </NativeSelect></label>
        {value.mode === "mr" ? <p className="text-xs text-muted-foreground">{t("mergeQueue.mrHint")}</p> : null}
        <Button className="min-h-11" type="submit" disabled={action.busy}>{t("mergeQueue.save")}</Button>
        {saved ? <p role="status">{t("mergeQueue.saved")}</p> : null}
      </form>
    </details> : null}
  </div>;
}

/** A batch's gate logs and screenshots, kept as artifacts of its MERGE-<id> run (61a). */
function MergeArtifacts({ project, runId, machineId }: { project: string; runId: string; machineId: string }) {
  const files = useArtifacts(project, undefined, runId, machineId);
  return <ArtifactRows files={files.data ?? []} error={files.error} loading={files.loading} onChanged={files.reload} context={runId} />;
}
