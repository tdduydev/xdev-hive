import { useHive, useAction, useCan, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Button } from "@xdev-hive/ui/components/ui/button";

export function ReleaseQueue({ project, onChanged }: { project: string; onChanged: () => void }) {
  const { client } = useHive(); const t = useT(); const can = useCan(); const action = useAction(); const poll = usePoll(15000);
  const data = useQuery(() => project ? client.call("autoRelease.list", { project }) : Promise.resolve(null), [client, project, poll, action.busy]);
  if (!data.data) return <ErrorNote error={data.error} />;
  const editable = can(project, "projectSettings");
  const act = (fn: () => Promise<unknown>) => void action.run(async () => { await fn(); onChanged(); });
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-release-queue><h2 className="text-base font-semibold">{t("autoRelease.title")}</h2>{data.data.paused ? <div className="space-y-2"><p className="text-sm text-danger">{t("autoRelease.paused")}</p>{editable ? <Button className="min-h-(--control-h-touch)" disabled={action.busy} onClick={() => act(() => client.call("autoRelease.resume", { project }))}>{t("autoRelease.resume")}</Button> : null}</div> : null}{!data.data.releases.length ? <p className="text-sm text-muted-foreground">{t("autoRelease.empty")}</p> : null}{data.data.releases.map(r => <div key={r.batchId} className="space-y-2 border-t border-border pt-3 text-sm"><p className="break-words">{r.batch.version} · {r.batchId} · {t(`autoRelease.${r.state}`)} · {r.machine}{r.step ? ` · ${t(`autoRelease.${r.step === "rollout" ? "appRollout" : r.step}`)}` : ""}</p>{r.warning ? <p className="text-warning">{t("autoRelease.warning")}</p> : null}{editable && r.state === "waiting" ? <div className="flex flex-wrap gap-2">{[true, false].map(pass => <Button key={String(pass)} className="min-h-(--control-h-touch)" variant={pass ? "default" : "outline"} disabled={action.busy} onClick={() => act(() => client.call("autoRelease.decide", { project, batchId: r.batchId, pass }))}>{t(pass ? "autoRelease.approve" : "autoRelease.reject")}</Button>)}</div> : null}{editable && r.state === "running" ? <Button className="min-h-(--control-h-touch)" variant="outline" disabled={action.busy} onClick={() => act(() => client.call("autoRelease.reconcile", { project, batchId: r.batchId }))}>{t("autoRelease.reconcile")}</Button> : null}</div>)}<ErrorNote error={action.error ?? data.error} /></section>;
}
