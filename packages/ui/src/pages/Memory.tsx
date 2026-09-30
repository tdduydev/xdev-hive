// Memory (docs/design/2026-09-redesign, xDev Hive Client): what agents learned, as a list with filter chips (pending,
// conflicts, needs review, stale) and the selected entry with what can be done to it. Search goes to the hub
// (words, or words and meaning when the hub has embeddings).
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { MEMORY_KINDS, stripHidden, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote, Notice } from "../components/common.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import { Chip, DetailBody, DetailFooter, DetailHeader, FilterChips, KvRows, ListItem, ListPane, type ChipKind } from "../components/panes.tsx";
import type { HiveClient } from "../client.ts";
import { formatTime, sourceText, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT, type TFunction } from "../i18n/index.tsx";
import { scopeKey, type Scope } from "../lib/scope.ts";
import { useToast } from "../shell/toast.tsx";

/** Value of the "Chung" option in the owner select (project keys are never empty). */
const SHARED_OPTION = "";
const NEW = -1;

type Filter = "all" | "pending" | "conflict" | "review" | "stale";
const FILTERS: Array<[Filter, (m: Memory) => boolean]> = [
  ["all", () => true],
  ["pending", (m) => m.status === "pending"],
  ["conflict", (m) => m.conflictsWith.length > 0],
  ["review", (m) => m.review !== null],
  ["stale", (m) => m.stale],
];

/**
 * memory.list / memory.search input for the scope: all → everything, shared → team-wide only, project → its entries + shared,
 * system → its projects' entries + shared. People see stale entries too (agents' searches skip them), so they can keep or remove them.
 */
function loadMemory(client: HiveClient, scope: Scope, query: string) {
  if (scope.kind === "project") {
    return query
      ? client.call("memory.search", { project: scope.project, query, limit: 50, includeStale: true })
      : client.call("memory.list", { project: scope.project, includeShared: true, limit: 500 });
  }
  if (scope.kind === "system") {
    return query
      ? client.call("memory.search", { projects: scope.projects, query, limit: 50, includeStale: true })
      : client.call("memory.list", { projects: scope.projects, includeShared: true, limit: 500 });
  }
  if (scope.kind === "shared") {
    return query ? client.call("memory.search", { query, limit: 50, includeStale: true }) : client.call("memory.list", { project: null, limit: 500 });
  }
  return query ? client.call("memory.search", { anyProject: true, query, limit: 50, includeStale: true }) : client.call("memory.list", { limit: 500 });
}

/** The chip an entry shows: what needs doing first, or nothing when it is simply in use. */
function stateOf(m: Memory, t: TFunction): { label: string; kind: ChipKind } | null {
  if (m.conflictsWith.length) return { label: t("memory.filter.conflict"), kind: "danger" };
  if (m.status === "pending") return { label: t("memory.filter.pending"), kind: "warning" };
  if (m.review) return { label: t("memory.filter.review"), kind: "warning" };
  if (m.supersededBy !== null) return { label: t("memory.replaced"), kind: "neutral" };
  if (m.stale) return { label: t("memory.filter.stale"), kind: "neutral" };
  return null;
}

export function MemoryPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<number | null>(null);

  const list = useQuery(() => loadMemory(client, scope, submitted), [client, scopeKey(scope), submitted]);
  // A hub from before this has no such method: the line just does not show.
  const search = useQuery(() => client.call("memory.searchInfo", {}), [client, list.data]);
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const shown = rows.filter(FILTERS.find(([id]) => id === filter)![1]);
  const current = selected === NEW ? null : (rows.find((m) => m.id === selected) ?? shown[0] ?? null);
  useEffect(() => {
    if (selected !== NEW && selected !== null && !rows.some((m) => m.id === selected)) setSelected(null);
  }, [rows, selected]);

  // New entries default to the scope: its project, Chung for the shared scope, the first project of a system or of all.
  const pool = scope.kind === "system" ? scope.projects : projects;
  const defaultOwner = scope.kind === "project" ? scope.project : scope.kind === "shared" ? null : (pool[0] ?? null);
  const canAdd = allow(null, "contribute") || projects.some((p) => allow(p, "contribute"));

  return (
    <div className="flex h-full min-h-0 w-full bg-surface">
      <ListPane
        label={t("nav.memory")}
        head={
          <>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                setSubmitted(query.trim());
              }}
            >
              <Input className="h-7 min-w-0 flex-1 text-xs" placeholder={t("memory.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("memory.searchLabel")} />
              {canAdd ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setSelected(NEW)}>
                  {t("memory.newEntry")}
                </Button>
              ) : null}
            </form>
            <FilterChips
              value={filter}
              onChange={setFilter}
              options={FILTERS.map(([id, test]) => ({ id, label: t(`memory.filter.${id}`), count: rows.filter(test).length }))}
            />
            {search.data?.mode === "hybrid" ? (
              <p className={cn("m-0 text-[11px]/4", search.data.lastError ? "text-warning" : "text-fg-muted")}>
                {search.data.lastError
                  ? t("memory.searchEmbedError", { error: search.data.lastError })
                  : t("memory.searchHybrid", { model: search.data.model ?? "", indexed: search.data.indexed, total: search.data.total })}
              </p>
            ) : null}
          </>
        }
      >
        <ErrorNote error={list.error} />
        {shown.map((m) => {
          const st = stateOf(m, t);
          return (
            <ListItem
              key={m.id}
              selected={m.id === current?.id}
              onClick={() => setSelected(m.id)}
              title={t("memory.itemTitle", { id: m.id, kind: t(`memoryKind.${m.kind}`) })}
              chip={st ? <Chip kind={st.kind} small>{st.label}</Chip> : null}
              sub={<span className={cn(m.supersededBy !== null && "line-through")}>{m.content}</span>}
              meta={`${m.project ?? t("inbox.shared")} · ${m.author}`}
              dim={m.stale || m.supersededBy !== null}
            />
          );
        })}
        {list.data && shown.length === 0 ? <p className="m-0 px-3 py-8 text-center text-xs text-fg-muted">{t("memory.none")}</p> : null}
      </ListPane>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected === NEW ? (
          <AddMemory
            defaultOwner={defaultOwner}
            projects={pool}
            onCancel={() => setSelected(null)}
            onAdded={(id) => {
              list.reload();
              setSelected(id);
            }}
          />
        ) : current ? (
          <MemoryDetail key={current.id} memory={current} all={rows} onChanged={list.reload} onOpen={setSelected} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">{list.data ? t("memory.pick") : null}</div>
        )}
      </div>
    </div>
  );
}

function MemoryDetail({ memory: m, all, onChanged, onOpen }: { memory: Memory; all: Memory[]; onChanged: () => void; onOpen: (id: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const action = useAction();
  const manage = allow(m.project, "manage");
  const st = stateOf(m, t);
  const run = (fn: () => Promise<unknown>, note: string) =>
    void action.run(async () => {
      await fn();
      toast(note);
      onChanged();
    });

  const rows: Array<[string, React.ReactNode, boolean?]> = [
    [t("memory.kvKind"), t(`memoryKind.${m.kind}`)],
    [t("memory.kvScope"), m.project ?? t("inbox.shared"), true],
    [t("memory.kvAuthor"), `${m.author} · ${formatTime(m.createdAt)}${sourceText(m.source, m.taskId)}`, true],
    [t("memory.kvUsed"), m.useCount ? t("memory.usedTimes", { count: m.useCount, time: formatTime(m.lastUsedAt) }) : t("memory.neverUsed")],
  ];
  if (m.taskId) rows.push([t("memory.kvTask"), <a className="text-fg-link underline underline-offset-2" href={`#/tasks?task=${encodeURIComponent(m.taskId)}`}>{m.taskId}</a>, true]);
  if (m.files.length)
    rows.push([
      t("memory.kvFiles"),
      <span className="flex flex-wrap gap-1">
        {m.files.map((f) => (
          <code
            key={f.path}
            className={cn(
              "rounded-xs bg-sunken px-1 py-px font-mono text-[11px] break-all",
              m.review?.changed.includes(f.path) && "text-warning",
              m.review?.missing.includes(f.path) && "text-danger line-through",
            )}
          >
            {f.path}
          </code>
        ))}
      </span>,
    ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        chips={st ? <Chip kind={st.kind}>{st.label}</Chip> : <Chip kind="success">{t("memory.inUse")}</Chip>}
        scope={m.project ?? t("inbox.shared")}
        when={formatTime(m.createdAt)}
        title={t("memory.detailTitle", { id: m.id })}
      />
      <DetailBody>
        <p className={cn("m-0 text-sm/[22px] text-pretty whitespace-pre-wrap text-fg-primary", m.supersededBy !== null && "text-fg-muted line-through")}>{m.content}</p>
        <KvRows rows={rows} />
        {m.supersedes !== null || m.supersededBy !== null ? (
          <p className="m-0 text-xs text-fg-muted">
            {[m.supersedes !== null ? t("memory.replaces", { id: m.supersedes }) : null, m.supersededBy !== null ? t("memory.replacedBy", { id: m.supersededBy }) : null].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {m.conflictsWith.map((id) => {
          const other = all.find((x) => x.id === id);
          return (
            <Notice key={id} tone="error">
              {other ? (
                <button type="button" className="cursor-pointer text-left underline-offset-2 hover:underline" onClick={() => onOpen(id)}>
                  {t("memory.conflictNote", { id, content: other.content })}
                </button>
              ) : (
                t("memory.conflictMissing", { id })
              )}
            </Notice>
          );
        })}
        {m.review ? (
          <Notice tone="warn">
            {[
              m.review.changed.length ? t("memory.filesChanged", { files: m.review.changed.join(", ") }) : null,
              m.review.missing.length ? t("memory.filesMissing", { files: m.review.missing.join(", ") }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {` · ${formatTime(m.review.at)}`}
          </Notice>
        ) : null}
        {m.stale && !m.review ? <Notice tone="info">{t("memory.staleHint")}</Notice> : null}
        <ErrorNote error={action.error} />
      </DetailBody>
      {manage ? (
        <DetailFooter>
          {m.status === "pending" ? (
            <Button size="sm" disabled={action.busy} onClick={() => run(() => client.call("memory.approve", { id: m.id }), t("memory.approvedToast", { id: m.id }))}>
              {t("memory.approve")}
            </Button>
          ) : null}
          {m.conflictsWith.slice(0, 1).map((other) => (
            <span key={other} className="contents">
              <Button size="sm" disabled={action.busy} onClick={() => run(() => client.call("memory.resolve", { id: m.id, other, keep: "this" }), t("memory.resolvedToast", { id: m.id }))}>
                {t("memory.keepThis")}
              </Button>
              <Button size="sm" variant="outline" disabled={action.busy} onClick={() => run(() => client.call("memory.resolve", { id: m.id, other, keep: "other" }), t("memory.resolvedToast", { id: m.id }))}>
                {t("memory.keepOther", { id: other })}
              </Button>
              <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => run(() => client.call("memory.resolve", { id: m.id, other, keep: "both" }), t("memory.resolvedToast", { id: m.id }))}>
                {t("memory.keepBoth")}
              </Button>
            </span>
          ))}
          {m.stale || m.review ? (
            <Button size="sm" variant={m.status === "pending" ? "outline" : "default"} disabled={action.busy} onClick={() => run(() => client.call("memory.keep", { id: m.id }), t("memory.keptToast", { id: m.id }))}>
              {m.review ? t("memory.stillTrue") : t("memory.keep")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="danger-outline"
            className="ml-auto"
            disabled={action.busy}
            onClick={() => {
              if (window.confirm(t("memory.confirmRemove"))) run(() => client.call("memory.remove", { id: m.id }), t("memory.removedToast", { id: m.id }));
            }}
          >
            {t("memory.remove")}
          </Button>
        </DetailFooter>
      ) : null}
    </div>
  );
}

function AddMemory({ defaultOwner, projects, onCancel, onAdded }: { defaultOwner: string | null; projects: string[]; onCancel: () => void; onAdded: (id: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const sharedOk = allow(null, "contribute");
  // undefined: not picked yet, so it follows the scope's default (the project list may still be loading).
  const [picked, setPicked] = useState<string | null>();
  const writable = projects.filter((p) => allow(p, "contribute"));
  const fallback = defaultOwner !== null && !allow(defaultOwner, "contribute") ? (sharedOk ? null : (writable[0] ?? null)) : defaultOwner;
  const owner = picked === undefined ? fallback : picked;
  const options = owner !== null && !writable.includes(owner) ? [owner, ...writable] : writable;
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [content, setContent] = useState("");
  const action = useAction();
  const submit = () =>
    void action.run(async () => {
      const text = content.trim();
      const m = await client.call("memory.write", owner === null ? { shared: true, kind, content: text } : { project: owner, kind, content: text });
      setContent("");
      toast(t("memory.addedToast"));
      onAdded(m.id);
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader title={t("memory.newTitle")} />
      <DetailBody>
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <Label htmlFor="memory-owner">{t("memory.owner")}</Label>
          <NativeSelect id="memory-owner" wrapperClassName="w-full" value={owner ?? SHARED_OPTION} onChange={(e) => setPicked(e.target.value === SHARED_OPTION ? null : e.target.value)}>
            {sharedOk ? <NativeSelectOption value={SHARED_OPTION}>{t("memory.sharedOption")}</NativeSelectOption> : null}
            {options.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Label htmlFor="memory-kind">{t("memory.kind")}</Label>
          <NativeSelect id="memory-kind" wrapperClassName="w-full" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`memoryKind.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Textarea
          autoFocus
          className="min-h-32"
          placeholder={owner === null ? t("memory.addShared") : t("memory.addFor", { project: owner })}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          aria-label={t("memory.content")}
        />
        <HiddenChars fields={[{ label: t("memory.content"), text: content }]} onStrip={() => setContent(stripHidden(content))} />
        <ErrorNote error={action.error} />
      </DetailBody>
      <DetailFooter>
        <Button size="sm" disabled={!content.trim() || action.busy} onClick={submit}>
          {t("memory.add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </DetailFooter>
    </div>
  );
}
