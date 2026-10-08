import { useEffect, useState } from "react";
import { Button } from "#ui/components/ui/button.tsx";
import { Input } from "#ui/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/components/ui/native-select.tsx";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { formatTime, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";

const kinds = ["run", "chat", "gate", "audit"] as const;
const PAGE_SIZE = 30;
export function HistoryPage() {
  const { client, scope } = useHive();
  const t = useT();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [task, setTask] = useState("");
  const [kind, setKind] = useState<typeof kinds[number] | "">("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const key = JSON.stringify([scopeKey(scope), query, task, kind, since, until]);
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) { setPreviousKey(key); setOffset(0); }
  const requestKey = `${key}:${offset}`;
  const invalidDates = !!since && !!until && since > until;
  const list = useQuery(async () => ({ key: requestKey, result: scope.kind === "shared" || invalidDates ? { entries: [], hasMore: false } : await client.call("history.list", {
    ...scopeFilter(scope), query: query || undefined, taskId: task.trim() || undefined, kind: kind || undefined,
    since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
    until: until ? new Date(`${until}T23:59:59.999`).toISOString() : undefined, offset, limit: PAGE_SIZE,
  }) }), [client, requestKey, invalidDates]);
  const data = list.data?.key === requestKey && !list.loading && !list.error ? list.data.result : undefined;
  return <Page><div className="min-w-0 space-y-4" data-history-page>
    <p className="text-sm text-fg-muted">{t("history.hint")}</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label className="min-w-0 space-y-1 text-sm"><span>{t("history.search")}</span><Input value={search} onChange={e => setSearch(e.target.value)} maxLength={200} className="min-h-11 text-base md:text-sm" data-history-search /></label>
      <label className="min-w-0 space-y-1 text-sm"><span>{t("history.task")}</span><Input value={task} onChange={e => setTask(e.target.value)} className="min-h-11 text-base md:text-sm" /></label>
      <label className="min-w-0 space-y-1 text-sm"><span>{t("history.kind")}</span><NativeSelect wrapperClassName="w-full" value={kind} onChange={e => setKind(e.target.value as typeof kind)} className="min-h-11 text-base md:text-sm"><NativeSelectOption value="">{t("history.all")}</NativeSelectOption>{kinds.map(k => <NativeSelectOption key={k} value={k}>{t(`history.${k}`)}</NativeSelectOption>)}</NativeSelect></label>
      <label className="min-w-0 space-y-1 text-sm"><span>{t("history.since")}</span><Input type="date" value={since} onChange={e => setSince(e.target.value)} className="min-h-11 text-base md:text-sm" /></label>
      <label className="min-w-0 space-y-1 text-sm"><span>{t("history.until")}</span><Input type="date" value={until} onChange={e => setUntil(e.target.value)} className="min-h-11 text-base md:text-sm" /></label>
    </div>
    <ErrorNote error={invalidDates ? t("history.invalidDates") : list.error} />
    {list.loading ? <p role="status" className="text-sm">{t("history.loading")}</p> : null}
    {data && !data.entries.length ? <p role="status" className="text-sm text-fg-muted">{t("history.empty")}</p> : null}
    <ol className="space-y-3" aria-label={t("history.title")}>{data?.entries.map(entry => <li key={entry.id} data-history-row className="min-w-0 space-y-2 rounded-lg border border-line-subtle p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"><span>{t(`history.${entry.kind}`)}</span><time dateTime={entry.at}>{formatTime(entry.at)}</time><span className="break-all">{entry.project} · {entry.actor}</span><span>{entry.status}</span></div>
      <a href={entry.href} className="inline-flex min-h-11 max-w-full items-center wrap-anywhere text-sm font-medium text-fg-link underline outline-none hover:text-fg-link-hover focus-visible:focus-ring">{entry.title || t(`history.${entry.kind}`)}</a>
      {entry.taskId ? <a href={`#/tasks?project=${encodeURIComponent(entry.project ?? "")}&task=${encodeURIComponent(entry.taskId)}`} className="ml-3 inline-flex min-h-11 items-center break-all text-sm text-fg-link underline outline-none focus-visible:focus-ring">{entry.taskId}</a> : null}
      {entry.detail ? <p className="whitespace-pre-wrap break-words text-sm text-fg-secondary">{entry.detail}</p> : null}
    </li>)}</ol>
    <nav aria-label={t("history.title")} className="flex flex-wrap items-center gap-3"><Button variant="outline" className="min-h-11" disabled={!offset || list.loading} onClick={() => setOffset(n => Math.max(0, n - PAGE_SIZE))}>{t("artifacts.previous")}</Button><span className="text-sm">{t("artifacts.pageNumber", { n: offset / PAGE_SIZE + 1 })}</span><Button variant="outline" className="min-h-11" disabled={!data?.hasMore || list.loading} onClick={() => setOffset(n => n + PAGE_SIZE)}>{t("artifacts.next")}</Button><Button variant="ghost" className="min-h-11" onClick={() => { setSearch(""); setQuery(""); setTask(""); setKind(""); setSince(""); setUntil(""); setOffset(0); }}>{t("history.reset")}</Button></nav>
  </div></Page>;
}
