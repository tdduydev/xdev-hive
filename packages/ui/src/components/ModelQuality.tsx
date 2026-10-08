import { useState } from "react";
import { useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Button } from "#ui/components/ui/button.tsx";

export function ModelQuality({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const query = useQuery(() => client.call("modelLearning.get", { project }), [client, project]);
  const [filter, setFilter] = useState("");
  const unknown = t("modelQuality.unknown");
  const rate = (pass: number, observed: number) => observed ? `${pass}/${observed} · ${Math.round(pass / observed * 100)}%` : unknown;
  const rows = query.data?.quality ?? [];
  const visible = rows.filter((row) => [row.kind, row.size, row.risk, row.machine, row.profile, row.model, row.effort, row.tier, row.plan].join(" ").toLowerCase().includes(filter.toLowerCase()));
  return <section className="space-y-3" data-model-quality>
    <h3 className="text-sm font-medium">{t("modelQuality.title")}</h3>
    <p className="text-sm text-muted-foreground">{t("modelQuality.cohort")}</p>
    <p className="text-sm text-muted-foreground">{t("modelQuality.meaning")}</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm">{t("modelQuality.filter")}<input className="min-h-(--control-h-touch) w-full rounded-md border border-border bg-card px-2 text-base" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      <Button className="min-h-(--control-h-touch)" variant="outline" disabled={query.loading} onClick={query.reload}>{t("modelQuality.refresh")}</Button>
    </div>
    <ErrorNote error={query.error} />
    {query.loading ? <p role="status" className="text-sm">{t("common.loading")}</p> : !visible.length ? <p className="text-sm" data-quality-empty>{t("modelQuality.empty")}</p> : <div className="grid gap-3 lg:grid-cols-2">{visible.map((row, i) => <article key={i} className="min-w-0 space-y-2 rounded-lg border border-border p-3 text-sm" data-quality-cohort>
      <h4 className="break-words font-medium">{row.model || unknown} · {row.profile || unknown}</h4>
      <p className="break-words text-muted-foreground">{[row.machine, row.plan, row.tier, row.effort].map((v) => v || unknown).join(" · ")}</p>
      <p>{[row.kind, row.size, row.risk].map((v) => v || unknown).join(" · ")}</p>
      <dl className="space-y-1">
        <div><dt className="inline">{t("modelQuality.done")}: </dt><dd className="inline">{rate(row.done, row.tasks)}</dd></div>
        <div><dt className="inline">{t("modelQuality.review")}: </dt><dd className="inline">{rate(row.reviewPass, row.reviewObserved)} · {t("modelQuality.missing", { count: row.tasks - row.reviewObserved })}</dd></div>
        <div><dt className="inline">{t("modelQuality.tests")}: </dt><dd className="inline">{rate(row.testPass, row.testObserved)} · {t("modelQuality.missing", { count: row.tasks - row.testObserved })}</dd></div>
        <div><dt className="inline">{t("modelQuality.retry")}: </dt><dd className="inline">{row.retryTasks}/{row.tasks} · {t("modelQuality.attempts", { count: row.retries })}</dd></div>
        <div><dt className="inline">{t("modelQuality.cost")}: </dt><dd className="inline">{row.costMedian === null ? unknown : `$${row.costMedian.toFixed(3)}`} · {row.costObserved}/{row.tasks}</dd></div>
        <div><dt className="inline">{t("modelQuality.duration")}: </dt><dd className="inline">{row.durationMedian === null ? unknown : t("modelQuality.minutes", { count: Math.round(row.durationMedian / 60000) })} · {row.durationObserved}/{row.tasks}</dd></div>
      </dl>
    </article>)}</div>}
  </section>;
}
