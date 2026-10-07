import { useEffect, useState } from "react";
import type { Artifact } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ArtifactPreview } from "#ui/components/Artifacts.tsx";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { formatTime, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fileSize } from "#ui/lib/chat.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";

const PAGE_SIZE = 50;
const kinds = ["markdown", "log", "json", "image", "text", "pdf"] as const;
type Kind = typeof kinds[number];

export function ArtifactsPage() {
  const { client, scope } = useHive();
  const t = useT();
  const [id, clearId] = useHashParam("artifact");
  const [taskParam] = useHashParam("task");
  const [runParam] = useHashParam("run");
  const [task, setTask] = useState(taskParam ?? "");
  const [run, setRun] = useState(runParam ?? "");
  useEffect(() => setTask(taskParam ?? ""), [taskParam]);
  useEffect(() => setRun(runParam ?? ""), [runParam]);
  const [machine] = useHashParam("machine");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [offset, setOffset] = useState(0);
  const [debounced, setDebounced] = useState(name);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(name), 200); return () => window.clearTimeout(timer); }, [name]);
  const key = `${scopeKey(scope)}:${debounced}:${task ?? ""}:${run ?? ""}:${kind}:${machine ?? ""}`;
  // Tie the page number to its filters to avoid querying an old offset when the scope changes.
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) { setPreviousKey(key); setOffset(0); }
  const listKey = `${key}:${offset}`;
  const query = useQuery(async () => ({ key: listKey, files: scope.kind === "shared" ? [] : await client.call("artifacts.list", { ...scopeFilter(scope), taskId: task || undefined, runId: run || undefined, machineId: machine || undefined, name: debounced, kind: kind || undefined, offset, limit: PAGE_SIZE + 1 }) }), [client, key, offset]);
  const files = { ...query, data: query.data?.key === listKey ? query.data.files : undefined };
  const preview = useQuery(async () => {
    if (!id || !/^\d+$/.test(id)) return null;
    // A direct link needs metadata only; bytes are fetched when the preview opens.
    return (await client.call("artifacts.get", { id: Number(id), metadataOnly: true }))?.artifact ?? null;
  }, [client, id]);
  const [open, setOpen] = useState<Artifact | null>(null);
  const list = files.loading || files.error ? [] : files.data?.slice(0, PAGE_SIZE) ?? [];
  const fields = [["search", name, setName], ["task", task ?? "", setTask], ["run", run ?? "", setRun]] as const;
  return <Page><div className="flex min-w-0 flex-col gap-4" data-artifacts-page>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{fields.map(([label, value, change]) => <label key={label} className="flex min-w-0 flex-col gap-1 text-sm"><span>{t(`artifacts.${label}`)}</span><Input value={value} onChange={(e) => change(e.target.value)} className="min-h-11 text-base md:text-sm" data-artifact-filter={label} /></label>)}
      <label className="flex flex-col gap-1 text-sm"><span>{t("artifacts.kind")}</span><NativeSelect wrapperClassName="w-full" value={kind} onChange={(e) => setKind(e.target.value as Kind | "")} className="min-h-11 text-base md:text-sm" data-artifact-filter="kind"><NativeSelectOption value="">{t("artifacts.all")}</NativeSelectOption>{kinds.map((k) => <NativeSelectOption key={k} value={k}>{t(`artifacts.${k}`)}</NativeSelectOption>)}</NativeSelect></label>
    </div>
    <ErrorNote error={files.error ?? preview.error} />
    {id && !preview.loading && !preview.error && !preview.data ? <ErrorNote error={t("errors.notFound")} /> : null}
    {files.loading ? <p role="status" className="text-sm">{t("artifacts.loading")}</p> : null}
    {!files.loading && !files.error && !list.length ? <p className="text-sm text-fg-muted">{t("artifacts.empty")}</p> : null}
    <div role="table" aria-label={t("artifacts.page")} className="min-w-0 rounded-lg border border-line-subtle">
      <div role="row" className="max-md:sr-only grid-cols-[minmax(0,2fr)_repeat(6,minmax(0,1fr))] gap-3 border-b border-line-subtle bg-subtle p-3 text-xs font-semibold md:grid">{(["name", "service", "task", "run", "profile", "time", "size"] as const).map((k) => <span role="columnheader" key={k}>{t(`artifacts.${k}`)}</span>)}</div>
      {list.map((a) => <div key={a.id} role="row" className="grid min-w-0 grid-cols-2 items-center gap-x-3 gap-y-1 border-b border-line-subtle p-3 text-xs last:border-b-0 md:grid-cols-[minmax(0,2fr)_repeat(6,minmax(0,1fr))]" data-artifact-row={a.name}>
        <div role="cell" className="col-span-2 min-w-0 md:col-span-1"><button type="button" onClick={() => setOpen(a)} className="min-h-11 w-full cursor-pointer break-all text-left text-sm font-medium text-fg-link underline outline-none hover:text-fg-link-hover focus-visible:focus-ring md:min-h-0">{a.name}</button></div>
        <span role="cell" className="break-all text-fg-secondary"><span className="md:hidden">{t("artifacts.service")}: </span>{a.project}</span>
        <div role="cell" className="min-w-0"><a href={`#/tasks?task=${encodeURIComponent(a.taskId)}`} className="inline-flex min-h-11 min-w-11 items-center break-all text-fg-link underline outline-none focus-visible:focus-ring md:min-h-0">{a.taskId}</a></div>
        <div role="cell" className="min-w-0"><a href={`#/runs?run=${encodeURIComponent(`${a.machineId}/${a.runId}`)}`} className="inline-flex min-h-11 min-w-11 items-center break-all text-fg-link underline outline-none focus-visible:focus-ring md:min-h-0">{a.runId}</a></div>
        <span role="cell" className="break-all text-fg-secondary"><span className="md:hidden">{t("artifacts.profile")}: </span>{a.profileId ?? "—"}</span>
        <span role="cell" className="break-words text-fg-muted">{formatTime(a.createdAt)}</span><span role="cell" className="text-fg-muted">{fileSize(a.size)}</span>
      </div>)}
    </div>
    <nav aria-label={t("artifacts.page")} className="flex flex-wrap items-center gap-3"><Button variant="outline" className="min-h-11" disabled={!offset || files.loading} onClick={() => setOffset((n) => Math.max(0, n - PAGE_SIZE))}>{t("artifacts.previous")}</Button><span className="text-sm">{t("artifacts.pageNumber", { n: offset / PAGE_SIZE + 1 })}</span><Button variant="outline" className="min-h-11" disabled={files.loading || (files.data?.length ?? 0) <= PAGE_SIZE} onClick={() => setOffset((n) => n + PAGE_SIZE)}>{t("artifacts.next")}</Button></nav>
    <ArtifactPreview artifact={open ?? (id && !preview.loading && !preview.error ? preview.data?.id === Number(id) ? preview.data : null : null)} onClose={() => { setOpen(null); if (id) clearId(); }} />
  </div></Page>;
}
