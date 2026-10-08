import { useMemo, useState } from "react";
import type { Machine, Task } from "@xdev-hive/core";
import { BLOCKER_KINDS, buildBlockers, type BlockerKind } from "#ui/lib/blockers.ts";
import { requestErrorText } from "#ui/lib/runs.ts";
import { useInbox } from "#ui/shell/inbox.tsx";
import { useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Empty, ErrorNote } from "#ui/components/common.tsx";

export function BlockerCenter({ tasks, machines, onOpen, project }: { tasks: Task[]; machines: Machine[]; onOpen: (id: string) => void; project?: string }) {
  const t = useT();
  const allow = useCan();
  const inbox = useInbox();
  const { client } = useHive();
  const poll = usePoll(30_000);
  const machineIds = [...new Set(tasks.flatMap(task => task.status !== "done" && task.agent && machines.some(m => m.id === task.agent!.machineId) ? [task.agent.machineId] : []))].sort();
  const queues = useQuery(async () => (await Promise.all(machineIds.map(machineId => client.call("tasks.agentQueue", { machineId })))).flat(), [client, machineIds.join("/"), poll]);
  const [kind, setKind] = useState<BlockerKind | "all">("all");
  const rows = useMemo(() => buildBlockers(tasks, machines, inbox.activeItems.filter(i => !project || i.scope === project), queues.data), [tasks, machines, inbox.activeItems, project, queues.data]);
  const filtered = rows.filter(row => kind === "all" || row.kind === kind);
  return <section className="space-y-3" data-blocker-center aria-label={t("blockers.title")}>
    <p className="text-sm text-fg-secondary">{t("blockers.hint")}</p>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("blockers.filter")}>
      {(["all", ...BLOCKER_KINDS] as const).map(k => <Button key={k} size="sm" variant={k === kind ? "default" : "outline"} className="max-md:min-h-11" aria-pressed={k === kind} onClick={() => setKind(k)} data-blocker-filter={k}>{t(`blockers.kind.${k}`)} ({rows.filter(r => k === "all" || r.kind === k).length})</Button>)}
    </div>
    <ErrorNote error={inbox.error ?? queues.error} />
    {inbox.loading || queues.loading ? <p role="status" className="text-sm">{t("blockers.loading")}</p> : null}
    {!filtered.length && !inbox.loading && !queues.loading && !inbox.error && !queues.error ? <Empty>{t("blockers.empty")}</Empty> : null}
    <ul className="m-0 list-none space-y-3 p-0">
      {filtered.map(row => <li key={row.key} className="space-y-2 rounded-lg border border-line-default bg-surface p-3" data-blocker-kind={row.kind}>
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-warning">{t(`blockers.kind.${row.kind}`)}</span><span className="break-all font-mono text-xs text-fg-muted">{row.project}</span></div>
        <p className="m-0 break-words text-sm font-semibold">{row.subject}</p>
        {row.detail ? <p className="m-0 whitespace-pre-wrap break-words text-sm text-fg-secondary">{row.error ? requestErrorText(row.error) : row.task?.agent?.hold && row.kind !== "dependency" && row.kind !== "offline" && row.kind !== "release" ? requestErrorText(row.task.agent.hold) : row.detail}</p> : null}
        {row.task?.waitingHidden && row.kind === "dependency" ? <p className="text-sm text-fg-muted">{t("blockers.hidden", { n: row.task.waitingHidden })}</p> : null}
        <p className="m-0 text-sm text-fg-secondary">{t(`blockers.next.${row.kind}`)}</p>
        {!allow(row.project || null, row.permission) ? <p className="m-0 text-sm text-fg-muted">{t("blockers.readOnly")}</p> : null}
        <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={() => { if (row.task) onOpen(row.task.id); else { inbox.reopen(row.key); window.location.hash = `#/today?item=${encodeURIComponent(row.key)}`; } }}>{t("blockers.open")}</Button>
      </li>)}
    </ul>
  </section>;
}
