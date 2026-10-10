import { useState } from "react";
import type { MemoryCleanupProposal } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Diff } from "#ui/components/Diff.tsx";
import { Badge, Empty, ErrorNote, Notice, STATUS_TONE } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { inScope, scopeProject } from "#ui/lib/scope.ts";

export function MemoryCleanupSettings() {
  const { client, projects, scope } = useHive();
  const allow = useCan();
  const t = useT();
  const action = useAction();
  const poll = usePoll(30_000);
  const list = useQuery(() => client.call("memory.cleanupSettings", {}), [client, poll]);
  const runs = useQuery(() => client.call("memory.cleanupRuns", {}), [client, poll]);
  const editable = projects.filter((p) => allow(p, "projectSettings") && inScope(scope, p));
  return <Card data-memory-cleanup-settings><CardContent className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">{t("cleanup.title")}</h2>
    <p className="text-sm text-fg-secondary">{t("cleanup.hint")}</p>
    <ErrorNote error={list.error ?? runs.error ?? action.error} />
    {editable.map((p) => {
      const enabled = list.data?.find((s) => s.project === p)?.enabled ?? false;
      const run = runs.data?.find((r) => r.project === p);
      return <div key={p} className="flex flex-col gap-1 border-t border-line-subtle pt-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <Checkbox data-cleanup-project={p} checked={enabled} disabled={action.busy || !list.data} onCheckedChange={(on) => void action.run(async () => {
            await client.call("memory.setCleanup", { project: p, enabled: on === true }); list.reload(); runs.reload();
          })} />
          <span className="min-w-0 break-words text-sm">{p}</span>
        </label>
        {run ? <p className="text-xs text-fg-muted">{t("cleanup.run", { id: run.id, status: t(`cleanup.runStatus.${run.status}`), time: formatTime(run.updatedAt) })} · {run.model}{run.profile ? ` · ${run.profile}` : ""}{run.costUsd !== null ? ` · $${run.costUsd.toFixed(4)}` : ""}{run.error ? ` · ${t(`cleanup.errors.${run.error}`)}` : ""}</p> : null}
      </div>;
    })}
  </CardContent></Card>;
}

export function MemoryCleanupProposals({ className = "p-4 md:p-6" }: { className?: string }) {
  const { client, scope } = useHive();
  const t = useT();
  const [history, setHistory] = useState(false);
  const list = useQuery(() => client.call("memory.cleanupProposals", scopeProject(scope) ? { project: scopeProject(scope)! } : {}), [client, scope]);
  const rows = (list.data ?? []).filter((p) => inScope(scope, p.project) && (history || p.status === "pending" || p.status === "conflict"));
  return <div className={`flex min-w-0 flex-col gap-3 ${className}`} data-memory-cleanup-proposals>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{t("cleanup.proposals")}</h2>
      <Button className="max-md:min-h-11" variant="outline" aria-pressed={history} onClick={() => setHistory(!history)}>{t(history ? "knowledge.pending" : "proposals.seeAll")}</Button>
    </div>
    <p className="text-sm text-fg-secondary">{t("cleanup.reviewHint")}</p>
    <ErrorNote error={list.error} />
    {list.data && !rows.length ? <Empty>{t("cleanup.none")}</Empty> : null}
    {rows.map((p) => <CleanupCard key={p.id} proposal={p} onChanged={list.reload} />)}
  </div>;
}

function CleanupCard({ proposal: p, onChanged }: { proposal: MemoryCleanupProposal; onChanged: () => void }) {
  const { client, bump } = useHive();
  const allow = useCan();
  const t = useT();
  const action = useAction();
  const manage = p.status === "pending" && allow(p.project, "memoryApprove");
  const decide = (accept: boolean) => void action.run(async () => {
    await client.call("memory.decideCleanup", { id: p.id, accept }); onChanged(); bump();
  });
  return <Card data-cleanup-proposal={p.id}><CardContent className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[p.status]}>{t(`proposalStatus.${p.status}`)}</Badge><span className="min-w-0 break-words text-sm">{t(`cleanup.${p.kind}`)} · {p.project} · #{p.id}</span></div>
    <p className="break-words text-sm font-semibold">{p.reason}</p>
    <p className="text-xs text-fg-muted">{t("cleanup.source", { id: p.runId })} · {formatTime(p.createdAt)}{p.reviewer ? ` · ${p.reviewer} · ${formatTime(p.decidedAt)}` : ""}</p>
    {p.status === "conflict" ? <Notice tone="warn">{t("cleanup.conflict")}</Notice> : null}
    {p.entries.map((m) => <div key={m.id} className="min-w-0 rounded-md border border-line-subtle p-3"><span className="text-xs text-fg-muted">#{m.id} · {t(`memoryKind.${m.kind}`)} · {m.author} · {formatTime(m.createdAt)}</span><p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>{m.stale ? <Badge tone="warn">{t("memory.staleTag")}</Badge> : null}{m.review ? <Notice tone="warn">{t("memory.filter.review")}</Notice> : null}{m.files.length ? <p className="break-words font-mono text-xs text-fg-muted">{m.files.map((f) => f.path).join(", ")}</p> : null}</div>)}
    {p.kind === "merge" ? <Diff before={p.entries.map((m) => m.content).join("\n\n")} after={p.content!} /> : null}
    {manage ? <div className="flex flex-wrap gap-2"><Button className="max-md:min-h-11" data-cleanup-approve disabled={action.busy} onClick={() => decide(true)}>{t("proposals.approve")}</Button><Button className="max-md:min-h-11" data-cleanup-reject variant="outline" disabled={action.busy} onClick={() => decide(false)}>{t("proposals.reject")}</Button></div> : null}
    <ErrorNote error={action.error} />
  </CardContent></Card>;
}
