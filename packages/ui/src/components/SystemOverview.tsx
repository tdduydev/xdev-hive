import { Card } from "@xdev-hive/ui/components/ui/card";
import { ErrorNote } from "#ui/components/common.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { rootScope, systemTree } from "#ui/lib/project-picker.ts";
import { projectScope } from "#ui/lib/scope.ts";
import { systemSummary } from "#ui/lib/system-overview.ts";

/** Both landing pages use the same sources and limits, so their system counts agree. */
export function SystemOverview({ compact = false }: { compact?: boolean }) {
  const { client, me, projects, systems, setScope } = useHive();
  const t = useT();
  const tick = usePoll(20_000);
  const tasks = useQuery(() => client.call("tasks.list", {}), [client, tick]);
  const runs = useQuery(async () => client.desktop ? client.desktop.runs({ limit: 200 }) : me.mode === "hub" ? client.call("runs.list", { limit: 200 }) : [], [client, me.mode, tick]);
  const proposals = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick]);
  const roots = systemTree(projects, systems);
  const labels = { open: t("overview.openTasks"), running: t("systemOverview.running"), pending: t("systemOverview.pending") };
  const ready = { open: tasks.data !== undefined, running: runs.data !== undefined, pending: tasks.data !== undefined && proposals.data !== undefined };
  const metrics = (counts: { open: number; running: number; pending: number }) => <dl className="grid grid-cols-3 gap-2">
    {(["open", "running", "pending"] as const).map((k) => <div key={k} className="min-w-0">
      <dt className="text-xs text-muted-foreground" title={k === "pending" ? t("systemOverview.pendingHint") : undefined}>{labels[k]}</dt>
      <dd data-system-count={k} className="text-lg font-semibold tabular-nums">{ready[k] ? counts[k] : "—"}</dd>
    </div>)}
  </dl>;
  return <section className="flex min-w-0 flex-col gap-3" aria-label={t("overview.systems")} data-system-overview>
    <h2 className="text-sm font-semibold">{t("overview.systems")}</h2>
    <ErrorNote error={tasks.error ?? runs.error ?? proposals.error} />
    <div className={compact ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"}>
      {roots.map((root) => {
        const counts = systemSummary(root, tasks.data ?? [], runs.data ?? [], proposals.data ?? []);
        return <Card key={`${root.virtual}:${root.name}`} className="min-w-0 gap-3 p-4" data-system-card={root.name} data-system-virtual={root.virtual}>
          <button type="button" className="min-h-11 cursor-pointer rounded-sm text-left font-semibold wrap-anywhere hover:text-primary focus-visible:focus-ring" onClick={() => setScope(rootScope(root))}>{root.name}</button>
          <div data-system-total>{metrics(counts)}</div>
          <ul className="flex flex-col gap-2 border-t pt-2">
            {counts.services.map((s) => <li key={s.project} className="min-w-0" data-system-service={s.project}>
              <button type="button" className="min-h-11 min-w-11 max-w-full cursor-pointer rounded-sm text-left font-mono text-xs wrap-anywhere hover:text-primary focus-visible:focus-ring" onClick={() => setScope(projectScope(s.project))}>{s.project}</button>
              {metrics(s)}
            </li>)}
          </ul>
        </Card>;
      })}
    </div>
    {(tasks.data?.length ?? 0) >= 500 || (runs.data?.length ?? 0) >= 200 ? <p className="text-xs text-muted-foreground">{t("systemOverview.capped")}</p> : null}
  </section>;
}
