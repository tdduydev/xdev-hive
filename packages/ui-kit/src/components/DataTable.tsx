import * as React from "react";
// The Web Admin's data table (docs/design/2026-09-redesign/DataTable.dc.html): search, filter selects, density,
// sortable columns, a checkbox column with a bulk bar, and pages. Everything happens on the rows it is given.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Minus, Search } from "lucide-react";
import { cn } from "cn";
import { useT } from "#kit/i18n/index.tsx";
import { ResponsiveCellLabel, ResponsiveTableFrame } from "#kit/components/ResponsiveTable.tsx";
import { pagesToShow } from "#kit/lib/table.ts";
import { fold } from "#kit/lib/text.ts";

export interface Column<T> {
  key: string;
  label: string;
  /** A CSS grid track: "96px", "minmax(220px,1fr)". */
  width: string;
  align?: "left" | "right";
  mono?: boolean;
  strong?: boolean;
  render: (row: T) => ReactNode;
  /** A second line under the value (hidden in compact density). */
  sub?: (row: T) => ReactNode;
  /** Sorting on this column; leave out to make it unsortable. */
  sortValue?: (row: T) => string | number;
  /** The full text for the cell's tooltip. */
  title?: (row: T) => string | undefined;
}

export interface Filter<T> {
  key: string;
  label: string;
  value: (row: T) => string;
  /** Options with labels; without them the values found in the rows are offered as they are. */
  options?: Array<{ value: string; label: string }>;
}

export interface Bulk {
  id: string;
  label: string;
  danger?: boolean;
}

const DENSITY_KEY = "hive-table-density";
const readDensity = (): "comfortable" | "compact" => {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  noun,
  filters = [],
  searchText,
  bulk,
  onBulk,
  onRowClick,
  selectedKey,
  dim,
  minWidth = 720,
  maxHeight = "62vh",
  toolbar,
  responsive = false,
}: {
  responsive?: boolean;
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  /** What a row is, for "Tìm trong 12 máy…" ("máy", "lượt chạy"). */
  noun: string;
  filters?: Array<Filter<T>>;
  searchText?: (row: T) => string;
  bulk?: Bulk[];
  onBulk?: (id: string, rows: T[]) => void;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  dim?: (row: T) => boolean;
  minWidth?: number;
  maxHeight?: string;
  /** More controls at the end of the toolbar. */
  toolbar?: ReactNode;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [density, setDensityState] = useState(readDensity);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const setDensity = (d: "comfortable" | "compact") => {
    setDensityState(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      // Not remembered.
    }
  };

  const matching = useMemo(() => {
    const needle = fold(q.trim());
    let out = rows.filter((r) => (!needle || !searchText || fold(searchText(r)).includes(needle)) && filters.every((f) => !values[f.key] || f.value(r) === values[f.key]));
    const col = sort ? columns.find((c) => c.key === sort.key) : null;
    if (col?.sortValue) {
      const v = col.sortValue;
      out = [...out].sort((a, b) => {
        const x = v(a);
        const y = v(b);
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort!.dir;
      });
    }
    return out;
  }, [rows, q, values, sort, columns, filters, searchText]);

  // A filter or a search changes what "all" means: start over.
  useEffect(() => {
    setPage(0);
    setAllMatching(false);
  }, [q, values, sort, size]);
  useEffect(() => {
    setPicked((cur) => new Set([...cur].filter((k) => rows.some((r) => rowKey(r) === k))));
  }, [rows, rowKey]);

  const pages = Math.max(1, Math.ceil(matching.length / size));
  const current = Math.min(page, pages - 1);
  const visible = matching.slice(current * size, current * size + size);
  const pageKeys = visible.map(rowKey);
  const pagePicked = pageKeys.filter((k) => picked.has(k)).length;
  const chosen = allMatching ? matching : rows.filter((r) => picked.has(rowKey(r)));
  const tracks = [...(bulk?.length ? ["16px"] : []), ...columns.map((c) => c.width)].join(" ");
  const compact = density === "compact";
  const filtering = Boolean(q.trim()) || Object.values(values).some(Boolean);

  const toggleSort = (c: Column<T>) => {
    if (!c.sortValue) return;
    setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.align === "right" ? -1 : 1 }));
  };
  const box = (on: boolean | "mixed", label: string, onClick: () => void) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={on === "mixed" ? "mixed" : on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid size-4 cursor-pointer place-items-center rounded-xs border-[1.5px] outline-none focus-visible:focus-ring",
        on ? "border-primary bg-primary text-primary-foreground" : "border-line-control bg-surface",
      )}
    >
      {on === "mixed" ? <Minus className="size-3" strokeWidth={3} /> : on ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  );

  return (
    <ResponsiveTableFrame enabled={responsive} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {searchText ? (
          <label className="relative flex h-[34px] max-md:h-11 max-w-[380px] min-w-[200px] flex-[1_1_240px] items-center">
            <Search className="pointer-events-none absolute left-2.5 size-[15px] text-fg-muted" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("table.search", { count: rows.length.toLocaleString(), noun })}
              aria-label={t("table.search", { count: rows.length.toLocaleString(), noun })}
              className="h-full w-full rounded-[9px] border border-line-default bg-surface pr-12 pl-8 text-[13px] text-fg-primary outline-none placeholder:text-fg-muted focus:border-ring focus:ring-3 focus:ring-selected"
            />
            {q ? (
              <button type="button" onClick={() => setQ("")} className="absolute right-2 cursor-pointer text-xs text-fg-link hover:underline">
                {t("table.clear")}
              </button>
            ) : null}
          </label>
        ) : null}
        {filters.map((f) => {
          const options = f.options ?? [...new Set(rows.map(f.value).filter(Boolean))].sort().map((v) => ({ value: v, label: v }));
          const on = Boolean(values[f.key]);
          return (
            <label
              key={f.key}
              className={cn("flex h-[34px] max-md:h-auto max-md:min-h-11 max-md:max-w-full max-md:flex-wrap items-center gap-1.5 rounded-[9px] border bg-surface pr-1 pl-2.5 text-xs text-fg-muted", on ? "border-line-selected" : "border-line-default")}
            >
              {f.label}
              <select
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="h-7 max-w-44 cursor-pointer rounded-sm bg-transparent pr-1 text-[13px] font-medium text-fg-strong outline-none focus-visible:focus-ring"
              >
                <option value="">{t("table.all")}</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        {filtering ? (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setValues({});
            }}
            className="cursor-pointer text-xs text-fg-link hover:underline"
          >
            {t("table.resetFilters")}
          </button>
        ) : null}
        {toolbar}
        <div role="radiogroup" aria-label={t("table.density")} className="ml-auto flex gap-0.5 rounded-[7px] bg-sunken p-0.5">
          {(["comfortable", "compact"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={density === d}
              onClick={() => setDensity(d)}
              className={cn("h-7 cursor-pointer rounded-[5px] px-2.5 text-xs/none font-semibold outline-none focus-visible:focus-ring", density === d ? "bg-surface text-fg-strong shadow-e1" : "text-fg-secondary")}
            >
              {t(`table.${d}`)}
            </button>
          ))}
        </div>
      </div>
      {responsive && bulk?.length ? (
        <label className="flex items-center gap-2 text-xs text-fg-muted md:hidden">
          {box(pagePicked === 0 ? false : pagePicked === pageKeys.length ? true : "mixed", t("table.selectPage"), () => {
            setAllMatching(false);
            setPicked((cur) => { const next = new Set(cur); if (pagePicked === pageKeys.length) pageKeys.forEach((k) => next.delete(k)); else pageKeys.forEach((k) => next.add(k)); return next; });
          })}
          {t("table.selectPage")}
        </label>
      ) : null}
      {responsive && columns.some((c) => c.sortValue) ? (
        <div className="flex flex-wrap items-center gap-2 md:hidden">
          <label className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
            {t("table.sort")}
            <select aria-label={t("table.sort")} className="min-w-0 max-w-48 rounded-sm border border-line-default bg-surface px-2" value={sort?.key ?? ""} onChange={(e) => { const c = columns.find((c) => c.key === e.target.value); setSort(c ? { key: c.key, dir: c.align === "right" ? -1 : 1 } : null); }}>
              <option value="">{t("table.defaultOrder")}</option>
              {columns.filter((c) => c.sortValue).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          {sort ? <button type="button" className="rounded-sm border border-line-default px-3 text-xs" onClick={() => setSort({ ...sort, dir: sort.dir === 1 ? -1 : 1 })}>{t(sort.dir === 1 ? "table.ascending" : "table.descending")}</button> : null}
        </div>
      ) : null}
      {bulk?.length && chosen.length ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-inverse px-3 py-2 text-[13px] text-fg-inverse">
          <span className="font-semibold">{t("table.selected", { count: chosen.length.toLocaleString(), noun })}</span>
          {!allMatching && pagePicked === pageKeys.length && matching.length > pageKeys.length ? (
            <button type="button" onClick={() => setAllMatching(true)} className="cursor-pointer underline">
              {t("table.selectAllMatching", { count: matching.length.toLocaleString(), noun })}
            </button>
          ) : null}
          <span className="flex-1" />
          {bulk.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => onBulk?.(b.id, chosen)}
              className={cn("h-7 cursor-pointer rounded-sm border px-2.5 text-xs font-semibold outline-none focus-visible:focus-ring", b.danger ? "border-danger-solid text-[#FFB4B4]" : "border-white/30 hover:bg-white/10")}
            >
              {b.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPicked(new Set());
              setAllMatching(false);
            }}
            className="h-7 cursor-pointer rounded-sm px-2 text-xs underline"
          >
            {t("table.clearSelection")}
          </button>
        </div>
      ) : null}
      <div data-card-scroll className="min-h-40 overflow-auto rounded-lg border border-line-default bg-surface" style={{ maxHeight }}>
        <div data-card-body role="table" aria-label={noun} aria-rowcount={Math.max(matching.length, 1) + 1} aria-colcount={columns.length + (bulk?.length ? 1 : 0)} style={{ minWidth }}>
          <div
            data-card-header
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-2 grid h-9 items-center gap-2.5 border-b border-line-subtle bg-sunken px-3.5 type-overline text-fg-muted uppercase"
            style={{ gridTemplateColumns: tracks }}
          >
            {bulk?.length ? <div role="columnheader" aria-label={t("table.selectPage")} className={responsive ? "max-md:[&_button]:hidden" : undefined}>{box(pagePicked === 0 ? false : pagePicked === pageKeys.length ? true : "mixed", t("table.selectPage"), () => {
              setAllMatching(false);
              setPicked((cur) => {
                const next = new Set(cur);
                if (pagePicked === pageKeys.length) pageKeys.forEach((k) => next.delete(k));
                else pageKeys.forEach((k) => next.add(k));
                return next;
              });
            })}</div> : null}
            {columns.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                className={cn("min-w-0 truncate", c.align === "right" && "text-right", sort?.key === c.key && "text-fg-strong")}
              >
                {c.sortValue ? (
                  <>
                    {responsive ? <span className="md:hidden">{c.label}</span> : null}
                    <button type="button" onClick={() => toggleSort(c)} title={t("table.sortBy", { column: c.label })} className={cn("max-w-full cursor-pointer truncate rounded-xs uppercase outline-none hover:text-fg-strong focus-visible:focus-ring", responsive && "max-md:hidden")}>
                      {c.label}
                      <span aria-hidden="true">{sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</span>
                    </button>
                  </>
                ) : c.label}
              </div>
            ))}
          </div>
          {visible.map((r, index) => {
            const k = rowKey(r);
            const on = picked.has(k) || allMatching;
            return (
              <div
                key={k}
                data-card-row
                data-card-selected={k === selectedKey || on || undefined}
                role="row"
                aria-rowindex={current * size + index + 2}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onRowClick(r); } } : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn(
                  "grid items-center gap-2.5 border-b border-line-subtle px-3.5 last:border-b-0",
                  compact ? "min-h-[34px] py-1" : "min-h-12 py-[7px]",
                  onRowClick && "cursor-pointer outline-none focus-visible:focus-ring",
                  k === selectedKey ? "bg-selected" : on ? "bg-selected/60" : "hover:bg-sunken",
                  dim?.(r) && "opacity-70",
                )}
                style={{ gridTemplateColumns: tracks }}
              >
                {bulk?.length
                  ? <div role="cell">{box(on, t("table.selectRow"), () => {
                      setAllMatching(false);
                      setPicked((cur) => {
                        const next = new Set(cur);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      });
                    })}</div>
                  : null}
                {columns.map((c) => (
                  <div role="cell" data-card-cell data-card-primary={c.key === (columns.find((col) => col.strong)?.key ?? columns[0]?.key) || undefined} data-card-actions={!c.label || undefined} key={c.key} title={c.title?.(r)} className={cn("flex min-w-0 flex-col gap-0.5", c.align === "right" && "items-end text-right")}>
                    <ResponsiveCellLabel ariaHidden>{c.label}</ResponsiveCellLabel>
                    <div data-card-value>
                    <div className={cn("w-full truncate text-[13px]/5 text-fg-primary", c.mono && "font-mono text-xs/5", c.strong && "font-semibold text-fg-strong", c.align === "right" && "tabular-nums")}>{c.render(r)}</div>
                    {c.sub ? <div className={cn("w-full truncate text-[11px]/4 text-fg-muted", compact && (responsive ? "md:hidden" : "hidden"))}>{c.sub(r)}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {matching.length === 0 ? <div role="row" aria-rowindex={2}><div role="cell" aria-colspan={columns.length + (bulk?.length ? 1 : 0)} className="p-8 text-center text-[13px] text-fg-muted">{t("table.empty")}</div></div> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span>
          {matching.length
            ? t("table.range", { from: (current * size + 1).toLocaleString(), to: Math.min(matching.length, (current + 1) * size).toLocaleString(), total: matching.length.toLocaleString(), noun })
            : ""}
          {filtering && matching.length !== rows.length ? ` ${t("table.filtered", { all: rows.length.toLocaleString() })}` : ""}
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5">
          {t("table.perPage")}
          <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="h-7 cursor-pointer rounded-sm border border-line-default bg-surface px-1.5 text-xs text-fg-strong">
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {pages > 1 ? (
          <div className="flex items-center gap-1">
            <button type="button" aria-label={t("table.prev")} disabled={current === 0} onClick={() => setPage(current - 1)} className="grid size-7 cursor-pointer place-items-center rounded-sm border border-line-default bg-surface disabled:cursor-default disabled:text-fg-disabled">
              <ChevronLeft className="size-3.5" />
            </button>
            {pagesToShow(current, pages).map((p, i) =>
              p === "…" ? (
                <span key={`e${i}`} className="px-1">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  aria-current={p === current ? "page" : undefined}
                  onClick={() => setPage(p)}
                  className={cn("h-7 min-w-7 cursor-pointer rounded-sm border px-1.5 font-mono", p === current ? "border-inverse bg-inverse text-fg-inverse" : "border-line-default bg-surface text-fg-secondary")}
                >
                  {p + 1}
                </button>
              ),
            )}
            <button type="button" aria-label={t("table.next")} disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="grid size-7 cursor-pointer place-items-center rounded-sm border border-line-default bg-surface disabled:cursor-default disabled:text-fg-disabled">
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </ResponsiveTableFrame>
  );
}
