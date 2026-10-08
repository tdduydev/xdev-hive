import { useState } from "react";
import type { AcceptanceEvidence as Evidence, EvidenceContext } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { useArtifacts } from "#ui/components/Artifacts.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { featureChecks, type FeatureItem } from "#ui/lib/features.ts";
import { formatTime, useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useToast } from "#ui/shell/toast.tsx";

const PAGE = 20;
const TONE: Record<Evidence["outcome"], ChipKind> = { passed: "success", failed: "danger", blocked: "warning", untested: "neutral" };
const selectClass = "min-h-11 w-full min-w-0 rounded-md border border-line-default bg-surface px-3 text-base text-fg-primary outline-none focus-visible:focus-ring md:text-sm";
const sameRevision = (row: Evidence, context: EvidenceContext) => row.specHash === context.specHash && row.commitSha === context.commitSha;

export function AcceptanceEvidence({ item }: { item: FeatureItem }) {
  const { client } = useHive();
  const t = useT();
  const [selected, setSelected] = useState("");
  const tasks = useQuery(async () => {
    const rows = item.spec ? await client.call("evidence.tasks", { project: item.project, specDir: item.spec.dir, specBranch: item.spec.branch }) : [];
    return { key: item.key, rows };
  }, [client, item.key, item.project, item.updatedAt]);
  const rows = tasks.data?.key === item.key ? tasks.data.rows : [];
  const taskId = rows.find(task => task.id === selected)?.id ?? rows[0]?.id;
  if (!item.spec) return null;
  return <section className="flex flex-col gap-4 rounded-lg border border-line-subtle bg-surface p-4" data-acceptance-evidence>
    <div><h3 className="m-0 text-base font-semibold text-fg-strong">{t("evidence.title")}</h3><p className="mt-1 text-sm/6 text-fg-secondary">{t("evidence.hint")}</p></div>
    <ErrorNote error={tasks.error} />
    {taskId ? <>
      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">{t("evidence.task")}<select className={selectClass} value={taskId} onChange={e => setSelected(e.target.value)} data-evidence-task>{rows.map(task => <option key={task.id} value={task.id}>{task.id} · {task.title}</option>)}</select></label>
      <Verification key={`${item.key}:${taskId}`} item={item} taskId={taskId} />
    </> : <p className="m-0 text-sm text-fg-secondary" role="status">{t(tasks.loading ? "common.loading" : "evidence.noTask")}</p>}
  </section>;
}

function Verification({ item, taskId }: { item: FeatureItem; taskId: string }) {
  const { client } = useHive();
  const t = useT();
  const canVerify = useCan()(item.project, "qaVerify");
  const [page, setPage] = useState(0);
  const poll = usePoll(30_000);
  const spec = item.spec!;
  const source = { project: item.project, taskId, specDir: spec.dir, specBranch: spec.branch };
  const key = `${item.key}:${taskId}:${page}:${spec.commit}`;
  const query = useQuery(async () => {
    const context = await client.call("evidence.context", source);
    const current: Evidence[] = [];
    if (context) {
      // Progress includes every criterion even after many verification attempts fill the first API page.
      for (let offset = 0; ; offset += 200) {
        const chunk = await client.call("evidence.list", { ...context, limit: 200, offset });
        current.push(...chunk);
        if (chunk.length < 200) break;
      }
    }
    const history = await client.call("evidence.list", { ...source, limit: PAGE + 1, offset: page * PAGE });
    return { key, context, current, history };
  }, [client, key, poll]);
  const data = query.data?.key === key ? query.data : undefined;
  const context = data?.context;
  const criteria = featureChecks(context?.specText ?? null);
  const latest = new Map<string, Evidence>();
  for (const row of data?.current ?? []) if (!latest.has(row.criterionId)) latest.set(row.criterionId, row);
  const done = criteria.filter(c => latest.get(c.id)?.outcome === "passed" && latest.get(c.id)?.criterion === c.text).length;
  return <>
    <ErrorNote error={query.error} />
    {query.loading ? <p className="text-sm text-fg-secondary" role="status">{t("common.loading")}</p> : null}
    {context ? <>
      <div className="flex flex-col gap-1 text-sm"><p className="m-0 font-medium text-fg-strong" data-evidence-progress>{t("evidence.progress", { done, total: criteria.length })}</p><p className="m-0 break-all font-mono text-xs text-fg-secondary">{t("evidence.revision", { sha: context.commitSha })}</p></div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">{criteria.map(criterion => {
        const row = latest.get(criterion.id);
        const outcome = row?.criterion === criterion.text ? row.outcome : "untested";
        return <li key={criterion.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-sunken p-3 text-sm"><span className="min-w-0 flex-1 break-words">{criterion.text}</span><Chip kind={TONE[outcome]}>{t(`evidence.${outcome}`)}</Chip></li>;
      })}</ul>
      {canVerify && criteria.length ? <RecordForm key={`${context.specHash}:${context.commitSha}`} context={context} onSaved={() => { setPage(0); query.reload(); }} /> : <p className="m-0 text-sm text-fg-secondary">{t(canVerify ? "features.checks.none" : "evidence.noRight")}</p>}
    </> : data ? <p className="m-0 text-sm text-fg-secondary">{t("evidence.noRevision")}</p> : null}
    <div className="flex flex-col gap-3"><h4 className="m-0 text-sm font-semibold">{t("evidence.history")}</h4>
      {data?.history.length === 0 ? <p className="m-0 text-sm text-fg-secondary">{t("evidence.empty")}</p> : null}
      {data?.history.slice(0, PAGE).map(row => <article key={row.id} className="flex flex-col gap-2 rounded-md border border-line-subtle bg-sunken p-3 text-sm" data-evidence-result={row.outcome}>
        <div className="flex flex-wrap items-start justify-between gap-2"><b className="min-w-0 flex-1 break-words text-fg-strong">{row.criterion}</b><Chip kind={TONE[row.outcome]}>{t(`evidence.${row.outcome}`)}</Chip></div>
        <p className="m-0 whitespace-pre-wrap break-words text-fg-secondary">{row.note}</p>
        <p className="m-0 break-words text-xs text-fg-muted">{row.recordedBy} · {formatTime(row.createdAt)}</p>
        <p className="m-0 break-all font-mono text-xs text-fg-secondary">{row.commitSha}</p>
        {context && !sameRevision(row, context) ? <p className="m-0 text-xs text-fg-secondary">{t("evidence.oldRevision")}</p> : null}
        {row.artifacts.map(file => <a key={file.id} href={`#/artifacts?artifact=${file.id}`} className="inline-flex min-h-11 items-center break-all text-fg-link underline underline-offset-2 focus-visible:focus-ring" title={file.sha256}>{file.name}</a>)}
      </article>)}
      <div className="flex flex-wrap items-center gap-2"><Button variant="outline" className="min-h-11" disabled={page === 0 || query.loading} onClick={() => setPage(p => p - 1)}>{t("evidence.previous")}</Button><span className="text-xs" role="status">{t("evidence.page", { page: page + 1 })}</span><Button variant="outline" className="min-h-11" disabled={!data || data.history.length <= PAGE || query.loading} onClick={() => setPage(p => p + 1)}>{t("evidence.next")}</Button></div>
    </div>
  </>;
}

function RecordForm({ context, onSaved }: { context: EvidenceContext; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const criteria = featureChecks(context.specText);
  const [criterionId, setCriterionId] = useState(criteria[0]?.id ?? "");
  const [outcome, setOutcome] = useState<Evidence["outcome"]>("untested");
  const [note, setNote] = useState("");
  const [artifactIds, setArtifactIds] = useState<number[]>([]);
  const files = useArtifacts(context.project, context.taskId);
  const criterion = criteria.find(c => c.id === criterionId);
  return <form className="flex flex-col gap-3 border-t border-line-subtle pt-4" onSubmit={e => {
    e.preventDefault();
    if (!criterion || action.busy) return;
    void action.run(async () => {
      await client.call("evidence.record", { ...context, criterionId, criterion: criterion.text, outcome, note, artifactIds });
      setNote(""); setArtifactIds([]); toast(t("evidence.saved")); onSaved();
    });
  }} data-evidence-form>
    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">{t("evidence.criterion")}<select className={selectClass} value={criterionId} onChange={e => setCriterionId(e.target.value)} disabled={action.busy} required data-evidence-criterion>{criteria.map(c => <option key={c.id} value={c.id}>{c.text}</option>)}</select></label>
    {criterion ? <p className="m-0 break-words text-sm/6 text-fg-secondary">{criterion.text}</p> : null}
    <label className="flex flex-col gap-1 text-sm font-medium">{t("evidence.outcome")}<select className={selectClass} value={outcome} onChange={e => setOutcome(e.target.value as Evidence["outcome"])} disabled={action.busy} data-evidence-outcome>{(["untested", "passed", "failed", "blocked"] as const).map(state => <option key={state} value={state}>{t(`evidence.${state}`)}</option>)}</select></label>
    <label className="flex flex-col gap-1 text-sm font-medium">{t("evidence.note")}<Textarea rows={4} required maxLength={4000} value={note} onChange={e => setNote(e.target.value)} disabled={action.busy} className="text-base md:text-sm" aria-describedby="evidence-note-hint" data-evidence-note /></label>
    <p id="evidence-note-hint" className="m-0 text-xs text-fg-secondary">{t("evidence.noteHint")}</p>
    <fieldset disabled={action.busy} className="flex min-w-0 flex-col gap-1"><legend className="mb-1 text-sm font-medium">{t("evidence.files")}</legend>
      <ErrorNote error={files.error} />
      {!files.data?.length ? <p className="m-0 text-xs text-fg-secondary">{t(files.loading ? "common.loading" : "evidence.noFiles")}</p> : null}
      {files.data?.map(file => <label key={file.id} className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-hover"><input type="checkbox" checked={artifactIds.includes(file.id)} disabled={!artifactIds.includes(file.id) && artifactIds.length >= 20} onChange={e => setArtifactIds(ids => e.target.checked ? [...ids, file.id] : ids.filter(id => id !== file.id))} /><span className="min-w-0 break-all text-sm">{file.name}</span></label>)}
      {artifactIds.length >= 20 ? <p className="m-0 text-xs text-fg-secondary">{t("evidence.fileLimit")}</p> : null}
    </fieldset>
    <ErrorNote error={action.error} />
    <Button type="submit" className="min-h-11 self-start" disabled={action.busy || !note.trim() || !criterion} data-evidence-save>{t(action.busy ? "common.loading" : "evidence.save")}</Button>
  </form>;
}
