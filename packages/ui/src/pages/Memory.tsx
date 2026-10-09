// Memory (docs/design/2026-09-redesign, xDev Hive Client): what agents learned, as a list with filter chips (pending,
// conflicts, needs review, stale) and the selected entry with what can be done to it. Search goes to the hub
// (words, or words and meaning when the hub has embeddings).
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { MEMORY_KINDS, stripHidden, systemOf, systemOwner, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Tag } from "#ui/components/ui/primitives.tsx";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { BulkBar, bulkSummary } from "#ui/components/BulkBar.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { DetailDialog } from "#ui/components/DetailDialog.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { HiddenChars } from "#ui/components/HiddenChars.tsx";
import { MemoryCleanupProposals } from "#ui/components/MemoryCleanup.tsx";
import { Chip, DetailBody, DetailFooter, DetailHeader, KvRows, PaneEmpty, type ChipKind } from "#ui/components/panes.tsx";
import type { HiveClient } from "#ui/client.ts";
import { formatTime, sourceText, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { runBulk, splitMemory } from "#ui/lib/bulk.ts";
import { shortAgo } from "#ui/lib/inbox.ts";
import { emptyState } from "#ui/lib/empty.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { defaultOwner, ownerName, scopeKey, type Scope } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

/** Value of the "Chung" option in the owner select (project keys are never empty). */
const SHARED_OPTION = "";
const NEW = -1;

type Filter = "all" | "pending" | "conflict" | "review" | "stale";
const FILTERS: Array<[Filter, (m: Memory) => boolean]> = [
  ["all", () => true],
  ["pending", (m) => m.status === "pending"],
  ["review", (m) => m.review !== null],
  ["conflict", (m) => m.conflictsWith.length > 0],
  // A replaced entry is done with: nothing to keep or remove, so not counted as stale.
  ["stale", (m) => m.stale && m.supersededBy === null],
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
  // Template colours: violet waiting for a person, amber for what may have drifted, red for a conflict.
  if (m.status === "pending") return { label: t("memory.filter.pending"), kind: "info" };
  if (m.review) return { label: t("memory.filter.review"), kind: "warning" };
  if (m.supersededBy !== null) return { label: t("memory.replaced"), kind: "neutral" };
  if (m.stale) return { label: t("memory.staleTag"), kind: "warning" };
  return null;
}

type LabelTone = "violet" | "red" | "amber" | "grey";
const labelClass: Record<LabelTone, string> = {
  violet: "bg-[var(--chip-violet-bg)] text-[var(--chip-violet-fg)]",
  red: "bg-[var(--chip-red-bg)] text-[var(--chip-red-fg)]",
  amber: "bg-[var(--chip-amber-bg)] text-[var(--chip-amber-fg)]",
  grey: "bg-[var(--chip-grey-bg)] text-[var(--chip-grey-fg)]",
};
const toneOf: Record<ChipKind, LabelTone> = { danger: "red", warning: "amber", neutral: "grey", info: "violet", success: "violet", running: "violet" };
const CODE = "[font-family:var(--font-code-design)]";

/** The card's labels: its state first, then what it replaces, then where it lives (template: "Chờ duyệt", "web"). */
function labelsOf(m: Memory, t: TFunction): Array<{ text: string; tone: LabelTone }> {
  const out: Array<{ text: string; tone: LabelTone }> = [];
  const st = stateOf(m, t);
  if (st) {
    const text = m.conflictsWith.length ? `${st.label} #${m.conflictsWith[0]}` : m.supersededBy !== null ? t("memory.replacedBy", { id: m.supersededBy }) : st.label;
    out.push({ text, tone: toneOf[st.kind] });
  }
  if (m.supersededBy === null) out.push({ text: ownerName(m.project, t("inbox.shared")), tone: "grey" });
  if (m.supersedes !== null) out.push({ text: t("memory.replaces", { id: m.supersedes }), tone: "violet" });
  return out;
}

/** `pendingFirst`: opened from a "waiting for approval" link (the old tab's address), so on the "Chờ duyệt" chip. */
export function MemoryPage({ pendingFirst = false }: { pendingFirst?: boolean }) {
  const { client, scope, projects, systems } = useHive();
  const t = useT();
  const allow = useCan();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [filter, setFilter] = useState<Filter>(pendingFirst ? "pending" : "all");
  // null: nothing open; NEW: the "write memory" form; an id: that entry's detail. A popup from the tablet width up, as the grid has no
  // side pane; on a phone a page of its own, kept in the address (?memory=) so Back returns to the list.
  const [popup, setPopup] = useState<number | null>(null);
  const mobileDetail = useMobileDetail("memory");
  const fromPhone = mobileDetail.value === "new" ? NEW : mobileDetail.value !== null && /^\d+$/.test(mobileDetail.value) ? Number(mobileDetail.value) : null;
  const selected = mobileDetail.mobile ? fromPhone : popup;
  const pick = (next: number | null) => {
    if (mobileDetail.mobile) mobileDetail.navigate(next === null ? null : next === NEW ? "new" : String(next));
    else setPopup(next);
  };
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const toast = useToast();
  const bulk = useAction();
  const quick = useAction();

  const list = useQuery(() => loadMemory(client, scope, submitted), [client, scopeKey(scope), submitted]);
  // A hub from before this has no such method: the line just does not show.
  const search = useQuery(() => client.call("memory.searchInfo", {}), [client, list.data]);
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const shown = rows.filter(FILTERS.find(([id]) => id === filter)![1]);
  const current = selected === null || selected === NEW ? null : (rows.find((m) => m.id === selected) ?? null);
  useEffect(() => {
    if (selected !== NEW && selected !== null && list.data && !rows.some((m) => m.id === selected)) pick(null);
    // pick changes with every render; the list and the selection are what decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected, list.data]);

  // New entries default to the scope: the system's own memory for a system and for a service of one (roadmap 40c), the
  // project of a repo in no system, Chung for the shared scope, the first project of all.
  const pool = scope.kind === "system" ? scope.projects : projects;
  const defaultOwnerOf = scope.kind === "all" ? (pool[0] ?? null) : defaultOwner(scope, systems, (o) => allow(o, "memoryWrite"));
  const canAdd = allow(null, "memoryWrite") || projects.some((p) => allow(p, "memoryWrite")) || systems.some((s) => allow(systemOwner(s.name), "memoryWrite"));
  const empty = emptyState({ loaded: Boolean(list.data), total: rows.length, shown: shown.length, query: submitted, filtered: filter !== "all" });
  // Nothing written yet is the only case with something to do: the first entry, from the same button as the toolbar's.
  const firstEntry = canAdd ? (
    <Button variant="glass" size="sm" data-empty-action onClick={() => pick(NEW)}>
      {t("memory.newFirst")}
    </Button>
  ) : null;

  // Pending entries of projects the person manages (as approving one by one), picked in bulk on the "Chờ duyệt" chip only.
  const selectable = filter !== "pending" ? [] : shown.filter((m) => m.status === "pending" && allow(m.project, "memoryApprove"));
  const chosen = selectable.filter((m) => picked.has(m.id));
  const label = (m: Memory) => `#${m.id}`;
  const finish = (text: string, trouble: boolean) => {
    toast(text, { tone: trouble ? "error" : "info" });
    setPicked(new Set());
    list.reload();
  };
  const approveAll = () =>
    void bulk.run(async () => {
      const { ready, conflicts } = splitMemory(chosen);
      const r = await runBulk(ready, async (m) => {
        await client.call("memory.approve", { id: m.id });
        return "done" as const;
      });
      r.conflicts.unshift(...conflicts);
      finish(bulkSummary(t, "approve", r, label), r.conflicts.length > 0 || r.failed.length > 0);
    });
  const rejectAll = () => {
    if (!window.confirm(t("bulk.confirmRejectMemory", { count: chosen.length }))) return;
    void bulk.run(async () => {
      const r = await runBulk(chosen, async (m) => {
        await client.call("memory.remove", { id: m.id });
        return "done" as const;
      });
      finish(bulkSummary(t, "reject", r, label), r.failed.length > 0);
    });
  };
  // The one button of a card (template): approve, keep, or open the conflict to choose.
  const cardAction = (m: Memory): { text: string; run: () => void } | null => {
    if (m.supersededBy !== null) return null;
    const manage = allow(m.project, "memoryApprove");
    if (m.conflictsWith.length) return manage ? { text: t("memory.choose"), run: () => pick(m.id) } : null;
    if (m.status === "pending") return manage ? { text: t("memory.approve"), run: () => void quick.run(async () => { await client.call("memory.approve", { id: m.id }); toast(t("memory.approvedToast", { id: m.id })); list.reload(); }) } : null;
    if (m.stale || m.review) return manage ? { text: m.review ? t("memory.stillTrue") : t("memory.keep"), run: () => void quick.run(async () => { await client.call("memory.keep", { id: m.id }); toast(t("memory.keptToast", { id: m.id })); list.reload(); }) } : null;
    return null;
  };

  // "1 giờ trước" on a card (template); the detail keeps the exact time.
  const ago = (iso: string) => {
    // Past a month the template counts months ("3 tháng trước"): "92 ngày" is harder to read at a glance.
    const months = Math.floor((Date.now() - Date.parse(iso)) / (30 * 86_400_000));
    if (months >= 1) return t("memory.monthsAgo", { n: months });
    const when = shortAgo(iso, Date.now(), t);
    return when === t("inbox.ago.now") ? when : t("inbox.agoLong", { when });
  };

  const detailTitle = selected === NEW ? t("memory.newTitle") : current ? t("memory.detailTitle", { id: current.id }) : t("nav.memory");
  const detail = (
    <>
      {selected === NEW ? (
          <AddMemory
            defaultOwner={defaultOwnerOf}
            projects={pool}
            onCancel={() => pick(null)}
            onAdded={(id) => {
              list.reload();
              pick(id);
            }}
          />
        ) : current ? (
          <MemoryDetail key={current.id} memory={current} all={rows} onChanged={list.reload} onOpen={pick} />
        ) : null}
    </>
  );
  if (mobileDetail.showingDetail) {
    return (
      <div className="flex min-w-0 flex-col" data-memory-page>
        <MobileBack onClick={() => pick(null)} />
        <div className="flex min-h-0 flex-1 flex-col">{detail}</div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col px-7 py-4" data-memory-page>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <Input controlSize="sm" className="w-56 max-w-full" placeholder={t("memory.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("memory.searchLabel")} />
        </form>
        {FILTERS.map(([id, test]) => (
          <button key={id} type="button" className="cursor-pointer border-0 bg-transparent p-0" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            <Tag active={filter === id}>{`${t(`memory.filter.${id}`)} · ${rows.filter(test).length}`}</Tag>
          </button>
        ))}
        <span className="flex-1" />
        {canAdd ? (
          <Button variant="glass" size="sm" onClick={() => pick(NEW)}>
            {t("memory.write")}
          </Button>
        ) : null}
      </div>
      {search.data?.mode === "hybrid" ? (
        <p className={cn("m-0 mb-3 text-[11px]/4", search.data.lastError ? "text-warning" : "text-fg-muted")}>
          {search.data.lastError ? t("memory.searchEmbedError", { error: search.data.lastError }) : t("memory.searchHybrid", { model: search.data.model ?? "", indexed: search.data.indexed, total: search.data.total })}
        </p>
      ) : null}
      {/* What the "Chờ duyệt" tab held besides the entries: the cleanup run's merge and removal suggestions. */}
      {filter === "pending" ? <MemoryCleanupProposals className="mb-4" /> : null}
      <BulkBar selectable={selectable.length} picked={chosen.length} busy={bulk.busy} onPickAll={() => setPicked(new Set(selectable.map((m) => m.id)))} onClear={() => setPicked(new Set())} onApprove={approveAll} onReject={rejectAll} />
      <ErrorNote error={list.error} />
      <ErrorNote error={bulk.error ?? quick.error} />
      {shown.length ? (
        <ul role="list" className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3 p-0">
          {shown.map((m) => {
            const files = m.files;
            const act = cardAction(m);
            const pickable = filter === "pending" && m.status === "pending" && allow(m.project, "memoryApprove");
            const used = m.useCount ? t("memory.cardUsed", { count: m.useCount }) : ago(m.createdAt);
            return (
              <li
                key={m.id}
                data-memory-card={m.id}
                onClick={() => pick(m.id)}
                className={cn(
                  "flex cursor-pointer flex-col gap-3 rounded-[20px] bg-[var(--surface-1)] p-[18px] shadow-[var(--ring-glass)]",
                  m.conflictsWith.length > 0 && "shadow-[var(--ring-danger)]",
                  (m.supersededBy !== null) && "opacity-[.55]",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {pickable ? (
                    <Checkbox
                      className="size-6"
                      checked={picked.has(m.id)}
                      aria-label={t("bulk.pickItem", { id: m.id })}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={(v) =>
                        setPicked((cur) => {
                          const next = new Set(cur);
                          if (v === true) next.add(m.id);
                          else next.delete(m.id);
                          return next;
                        })
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("memory.itemTitle", { id: m.id, kind: t(`memoryKind.${m.kind}`) })}
                    onClick={(e) => { e.stopPropagation(); pick(m.id); }}
                    className={cn("cursor-pointer border-0 bg-transparent p-0 text-[12px]/none font-semibold text-[var(--text-muted)]", CODE)}
                  >
                    #{m.id}
                  </button>
                  {labelsOf(m, t).map((lb) => (
                    <span key={lb.text} className={cn("inline-flex h-5 items-center rounded-full px-2 [font:var(--design-micro)]", labelClass[lb.tone])}>
                      {lb.text}
                    </span>
                  ))}
                </div>
                <p className={cn("m-0 text-pretty text-[var(--text-strong)] [font:var(--design-body-sm)]", m.supersededBy !== null && "line-through")}>{m.content}</p>
                {m.review && files.length ? (
                  <div className="flex flex-col gap-1 rounded-[12px] bg-[var(--surface-sunken)] px-3 py-2.5">
                    {files.map((f) => {
                      const changed = m.review!.changed.includes(f.path) || m.review!.missing.includes(f.path);
                      return (
                        <span key={f.path} className={cn("flex gap-2 text-[11.5px]/[18px] font-medium text-[var(--text-secondary)]", CODE)}>
                          <span className={changed ? "text-[var(--mark-changed)]" : "text-[var(--mark-same)]"}>{changed ? "≠" : "="}</span>
                          {f.path}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                <div className="mt-auto flex items-center gap-2">
                  <span className="flex-1 text-[var(--text-muted)] [font:var(--design-caption)]">
                    {m.supersededBy !== null ? `${m.author} · ${ago(m.createdAt)}` : m.stale ? t("memory.cardUnusedDays", { days: Math.max(0, Math.floor((Date.now() - Date.parse(m.lastUsedAt ?? m.createdAt)) / 86_400_000)) }) : `${m.author} · ${used}`}
                  </span>
                  {act ? (
                    <Button variant="glass" size="sm" disabled={quick.busy} onClick={(e) => { e.stopPropagation(); act.run(); }}>
                      {act.text}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {empty ? <PaneEmpty action={empty === "none" ? firstEntry : null}>{t(`memory.${empty}`)}</PaneEmpty> : null}
      {mobileDetail.mobile ? null : (
        <DetailDialog open={selected !== null} onClose={() => pick(null)} title={detailTitle} className="h-auto max-h-[85vh] w-[min(720px,calc(100%-2rem))]">
          {detail}
        </DetailDialog>
      )}
    </div>
  );
}


function MemoryDetail({ memory: m, all, onChanged, onOpen }: { memory: Memory; all: Memory[]; onChanged: () => void; onOpen: (id: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const action = useAction();
  const manage = allow(m.project, "memoryApprove");
  const st = stateOf(m, t);
  const run = (fn: () => Promise<unknown>, note: string) =>
    void action.run(async () => {
      await fn();
      toast(note);
      onChanged();
    });

  const rows: Array<[string, React.ReactNode, boolean?]> = [
    [t("memory.kvKind"), t(`memoryKind.${m.kind}`)],
    [t("memory.kvScope"), ownerName(m.project, t("inbox.shared")), true],
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
        scope={ownerName(m.project, t("inbox.shared"))}
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
  const { client, systems } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const sharedOk = allow(null, "memoryWrite");
  // undefined: not picked yet, so it follows the scope's default (the project list may still be loading).
  const [picked, setPicked] = useState<string | null>();
  // Systems (sys:<name>, roadmap 19c) first: what every service of one needs to know.
  const writable = [...systems.map((s) => systemOwner(s.name)), ...projects].filter((p) => allow(p, "memoryWrite"));
  const fallback = defaultOwner !== null && !allow(defaultOwner, "memoryWrite") ? (sharedOk ? null : (writable[0] ?? null)) : defaultOwner;
  const owner = picked === undefined ? fallback : picked;
  const options = owner !== null && !writable.includes(owner) ? [owner, ...writable] : writable;
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [content, setContent] = useState("");
  const action = useAction();
  const submit = () =>
    void action.run(async () => {
      const text = content.trim();
      const system = systemOf(owner);
      const m = await client.call(
        "memory.write",
        owner === null ? { shared: true, kind, content: text } : system !== null ? { system, kind, content: text } : { project: owner, kind, content: text },
      );
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
                {ownerName(p, p)}
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
