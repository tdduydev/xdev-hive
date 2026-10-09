import { useEffect, useState } from "react";
import { Button } from "#ui/components/ui/button.tsx";
import { Input } from "#ui/components/ui/input.tsx";
import { Tag } from "#ui/components/ui/primitives.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/components/ui/native-select.tsx";
import { ErrorNote, Page } from "#ui/components/common.tsx";
import { formatTime, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";

const kinds = ["run", "chat", "gate", "audit"] as const;
const PAGE_SIZE = 30;
// One accent per source so a day of mixed entries can be scanned by colour.
const DOT = { run: "violet", chat: "green", gate: "blue", audit: "red" } as const;
const formatClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
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
  const toIso = (d: string, end?: boolean) => {
    if (!d) return undefined;
    const date = new Date(end ? `${d}T23:59:59.999` : `${d}T00:00:00`);
    return isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  const list = useQuery(async () => ({ key: requestKey, result: scope.kind === "shared" || invalidDates ? { entries: [], hasMore: false } : await client.call("history.list", {
    ...scopeFilter(scope), query: query || undefined, taskId: task.trim() || undefined, kind: kind || undefined,
    since: toIso(since), until: toIso(until, true), offset, limit: PAGE_SIZE,
  }) }), [client, requestKey, invalidDates]);
  const data = list.data?.key === requestKey && !list.loading && !list.error ? list.data.result : undefined;
  const days = [...(data?.entries ?? []).reduce((map, entry) => map.set(dayLabel(entry.at), [...(map.get(dayLabel(entry.at)) ?? []), entry]), new Map<string, NonNullable<typeof data>["entries"]>())];
  return <Page><div className="min-w-0 space-y-4" data-history-page>
    <p className="sr-only">{t("history.hint")}</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label className="min-w-0 space-y-1.5 text-[length:12px] font-semibold text-fg-secondary"><span>{t("history.search")}</span><Input value={search} onChange={e => setSearch(e.target.value)} maxLength={200} data-history-search /></label>
      <label className="min-w-0 space-y-1.5 text-[length:12px] font-semibold text-fg-secondary"><span>{t("history.task")}</span><Input value={task} onChange={e => setTask(e.target.value)} /></label>
      <label className="min-w-0 space-y-1.5 text-[length:12px] font-semibold text-fg-secondary"><span>{t("history.kind")}</span><NativeSelect wrapperClassName="w-full" value={kind} onChange={e => setKind(e.target.value as typeof kind)} className="h-[44px] rounded-[12px] border-0 bg-sunken text-base shadow-[var(--ring-glass)] md:text-sm"><NativeSelectOption value="">{t("history.all")}</NativeSelectOption>{kinds.map(k => <NativeSelectOption key={k} value={k}>{t(`history.${k}`)}</NativeSelectOption>)}</NativeSelect></label>
      <label className="min-w-0 space-y-1.5 text-[length:12px] font-semibold text-fg-secondary"><span>{t("history.since")}</span><Input type="date" value={since} onChange={e => setSince(e.target.value)} /></label>
      <label className="min-w-0 space-y-1.5 text-[length:12px] font-semibold text-fg-secondary"><span>{t("history.until")}</span><Input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label>
    </div>
    <ErrorNote error={invalidDates ? t("history.invalidDates") : list.error} />
    {list.loading ? <p role="status" className="text-sm">{t("history.loading")}</p> : null}
    {data && !data.entries.length ? <p role="status" className="text-sm text-fg-muted">{t("history.empty")}</p> : null}
    <div className="flex max-w-[880px] flex-col gap-5">{days.map(([day, entries]) => <section key={day} className="flex flex-col gap-1" aria-label={day}>
      <h2 className="m-0 px-0 pb-2 [font:var(--type-overline)] text-[length:11px] uppercase tracking-[0.5px] text-fg-faint">{day}</h2>
      <ol className="m-0 flex list-none flex-col overflow-hidden rounded-[20px] bg-surface-1 p-0 shadow-[var(--ring-glass)]" aria-label={day}>{entries.map(entry => <li key={entry.id} data-history-row className="grid min-w-0 grid-cols-[52px_10px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-[18px] py-3 shadow-[inset_0_-1px_0_var(--border-subtle)] md:grid-cols-[52px_10px_minmax(0,1fr)_auto]">
        <time dateTime={entry.at} className="font-mono text-[12px] font-medium leading-none text-fg-muted">{formatClock(entry.at)}</time>
        <span aria-hidden className="size-2 rounded-full" style={{ background: `var(--accent-${DOT[entry.kind]})`, boxShadow: `0 0 8px var(--accent-${DOT[entry.kind]})` }} />
        <span className="min-w-0 text-[length:13px] leading-5 text-fg-strong">
          <span className="text-fg-secondary">{[entry.actor, t(`history.${entry.kind}`)].filter(Boolean).join(" · ")}</span>{" "}
          <a href={entry.href} className="wrap-anywhere text-fg-strong underline-offset-2 outline-none hover:underline focus-visible:focus-ring">{entry.title || t(`history.${entry.kind}`)}</a>
          {entry.taskId ? <a href={`#/tasks?${entry.project ? `project=${encodeURIComponent(entry.project)}&` : ""}task=${encodeURIComponent(entry.taskId)}`} className="ml-2 break-all text-fg-link underline outline-none focus-visible:focus-ring">{entry.taskId}</a> : null}
          {entry.status ? <span className="ml-2 text-fg-muted">{entry.status}</span> : null}
          {entry.detail ? <p className="m-0 whitespace-pre-wrap break-words text-fg-secondary">{entry.detail}</p> : null}
        </span>
        {entry.project ? <span className="col-start-3 break-all text-[length:12px] font-medium leading-4 text-fg-muted md:col-start-auto">{entry.project}</span> : null}
      </li>)}</ol>
    </section>)}</div>
    <nav aria-label={t("history.title")} className="flex flex-wrap items-center gap-3"><Button variant="glass" size="sm" disabled={!offset || list.loading} onClick={() => setOffset(n => Math.max(0, n - PAGE_SIZE))}>{t("artifacts.previous")}</Button><Tag>{t("artifacts.pageNumber", { n: offset / PAGE_SIZE + 1 })}</Tag><Button variant="glass" size="sm" disabled={!data?.hasMore || list.loading} onClick={() => setOffset(n => n + PAGE_SIZE)}>{t("artifacts.next")}</Button><Button variant="ghost" size="sm" onClick={() => { setSearch(""); setQuery(""); setTask(""); setKind(""); setSince(""); setUntil(""); setOffset(0); }}>{t("history.reset")}</Button></nav>
  </div></Page>;
}
