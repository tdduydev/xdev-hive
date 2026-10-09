// The three generic blocks of the Claude Design admin (template adminStats / adminCards / adminTable, R-72l): the
// operations tabs only choose the data, so they all read as one family. Sizes live in cosmic-admin-ops.css.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { type AdminTone } from "#ui/lib/admin-ops.ts";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { useT } from "#ui/i18n/index.tsx";
import { filterItems, pageItems, sortItems, TABLE_PAGE_SIZE, type SortDir, type TableItem } from "#ui/lib/admin-table.ts";

/** A dot's colour is a tone, not a hex, so light and dark themes both get a readable one. */

const dotStyle = (tone: AdminTone = "neutral"): CSSProperties => ({ ["--dot" as string]: `var(--cx-tone-${tone})` });

export { toneForRatio, usedPercent, type AdminTone } from "#ui/lib/admin-ops.ts";

export interface AdminStat {
  key?: string;
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: AdminTone;
  /** Makes the tile a link (the overview's tiles open the page they count). */
  href?: string;
}

export function AdminStats({ stats }: { stats: AdminStat[] }) {
  return (
    <div className="cx-ops-stats">
      {stats.map((s) => {
        const body = (
          <>
            <span className="cx-ops-stat-label">
              <i className="cx-ops-dot cx-ops-dot-glow" style={dotStyle(s.tone)} />
              {s.label}
            </span>
            <strong>{s.value}</strong>
            {s.note ? <span className="cx-ops-stat-note">{s.note}</span> : null}
          </>
        );
        return s.href ? (
          <a key={s.key ?? s.label} href={s.href} className="cx-ops-stat" data-link>
            {body}
          </a>
        ) : (
          <div key={s.key ?? s.label} className="cx-ops-stat">
            {body}
          </div>
        );
      })}
    </div>
  );
}

export interface AdminCard {
  key: string;
  title: ReactNode;
  side?: ReactNode;
  body?: ReactNode;
  tone?: AdminTone;
  /** 0-100; the bar takes the card's tone. */
  bar?: number | null;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** More controls after the action (a second button, a toggle) that the design does not draw. */
  extra?: ReactNode;
  /** Dimmed: a closed incident, a paused rule. */
  dim?: boolean;
}

export function AdminCards({ cards }: { cards: AdminCard[] }) {
  return (
    <div className="cx-ops-cards">
      {cards.map((c) => (
        <div key={c.key} className="cx-ops-card" data-dim={c.dim || undefined}>
          <div className="cx-ops-card-head">
            <i className="cx-ops-dot cx-ops-dot-lg cx-ops-dot-glow" style={dotStyle(c.tone)} />
            <span className="cx-ops-card-title">{c.title}</span>
            {c.side ? <span className="cx-ops-card-side">{c.side}</span> : null}
          </div>
          {c.body ? <div className="cx-ops-card-body">{c.body}</div> : null}
          {typeof c.bar === "number" ? (
            <div className="cx-ops-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.bar}>
              <div style={{ width: `${c.bar}%`, ...dotStyle(c.tone) }} />
            </div>
          ) : null}
          {c.action || c.extra ? (
            <div className="cx-ops-card-actions">
              {c.action ? (
                <Button variant="glass" size="sm" disabled={c.action.disabled} onClick={c.action.onClick}>
                  {c.action.label}
                </Button>
              ) : null}
              {c.extra}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export interface AdminCell {
  text: ReactNode;
  sub?: ReactNode;
  tone?: AdminTone;
  /** Mono for ids and times, strong for the row's name. */
  mono?: boolean;
  strong?: boolean;
  title?: string;
}

export interface AdminRow extends TableItem {
  key: string;
  cells: AdminCell[];
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Controls the design does not draw (a second button): sit with the row action. */
  extra?: ReactNode;
}

export interface AdminFilter {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

interface AdminTableProps {
  cols: string[];
  grid: string;
  minWidth?: number;
  rows: AdminRow[];
  empty?: ReactNode;
  /** Search box over each row's `search`; filters over its `tags`; headers sort by `sort`; pages of `pageSize`. */
  searchable?: boolean;
  filters?: AdminFilter[];
  pageSize?: number;
  /** What the rows are, for the count line ("12 máy"). */
  noun?: string;
}

/**
 * `grid` is a grid-template-columns value (the last track, if the table has row actions, is the actions column);
 * `minWidth` is where the table stops shrinking and scrolls inside its own frame instead of widening the page.
 */
export function AdminTable({ cols, grid, minWidth = 720, rows, empty, searchable, filters, pageSize = TABLE_PAGE_SIZE, noun }: AdminTableProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ col: number | null; dir: SortDir }>({ col: null, dir: "asc" });
  const [page, setPage] = useState(1);
  const hasActions = rows.some((r) => r.action || r.extra);
  const template = hasActions ? `${grid} auto` : grid;
  const sortable = (i: number) => rows.some((r) => r.sort && r.sort[i] !== undefined);
  const toolbar = !!searchable || !!filters?.length;
  const shown = useMemo(() => sortItems(filterItems(rows, query, active), sort.col, sort.dir), [rows, query, active, sort]);
  const paged = pageItems(shown, page, pageSize);
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const pickSort = (i: number) => setSort((s) => (s.col === i ? (s.dir === "asc" ? { col: i, dir: "desc" } : { col: null, dir: "asc" }) : { col: i, dir: "asc" }));
  return (
    <>
      {toolbar ? (
        <div className="cx-ops-toolbar" data-table-toolbar>
          {searchable ? (
            <Input className="h-8 w-56 max-md:min-h-11 max-md:w-full" type="search" value={query} placeholder={t("adminTable.search")} aria-label={t("adminTable.search")} onChange={(e) => reset(setQuery)(e.target.value)} />
          ) : null}
          {filters?.map((f) => (
            <select key={f.key} className="cx-select" data-table-filter={f.key} aria-label={f.label} value={active[f.key] ?? ""} onChange={(e) => reset(setActive)({ ...active, [f.key]: e.target.value })}>
              <option value="">{`${f.label}: ${t("adminTable.all")}`}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ))}
          <span className="cx-ops-count" role="status">
            {noun ? `${shown.length} ${noun}` : shown.length}
          </span>
        </div>
      ) : null}
      <div className="cx-ops-table" role="table">
        <div style={{ minWidth }}>
          <div className="cx-ops-table-head" role="row" style={{ gridTemplateColumns: template }}>
            {cols.map((c, i) =>
              sortable(i) ? (
                <span key={`${i}-${c}`} role="columnheader" aria-sort={sort.col === i ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="cx-ops-sort" data-sort={sort.col === i ? sort.dir : undefined} onClick={() => pickSort(i)}>
                    {c}
                  </button>
                </span>
              ) : (
                <span key={`${i}-${c}`} role="columnheader">
                  {c}
                </span>
              ),
            )}
            {hasActions ? <span aria-hidden /> : null}
          </div>
          {paged.rows.map((r) => (
            <div key={r.key} className="cx-ops-table-row" role="row" style={{ gridTemplateColumns: template }}>
              {r.cells.map((cell, i) => (
                <span key={i} role="cell" className="cx-ops-cell">
                  {cell.tone ? <i className="cx-ops-dot" style={dotStyle(cell.tone)} /> : null}
                  <span className="cx-ops-cell-text">
                    <span data-mono={cell.mono || undefined} data-strong={cell.strong || undefined} title={cell.title}>
                      {cell.text}
                    </span>
                    {cell.sub ? <small>{cell.sub}</small> : null}
                  </span>
                </span>
              ))}
              {hasActions ? (
                <span role="cell" className="cx-ops-row-actions">
                  {r.action ? (
                    <Button variant="ghost" size="sm" disabled={r.action.disabled} onClick={r.action.onClick}>
                      {r.action.label}
                    </Button>
                  ) : null}
                  {r.extra}
                </span>
              ) : null}
            </div>
          ))}
          {!paged.rows.length ? <div className="cx-ops-table-empty">{rows.length ? t("adminTable.noMatch") : empty}</div> : null}
        </div>
      </div>
      {paged.pages > 1 ? (
        <div className="cx-ops-pager" data-table-pager>
          <span role="status">{t("adminTable.range", { from: paged.from, to: paged.to, total: paged.total })}</span>
          <Button variant="glass" size="sm" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>
            {t("adminTable.prev")}
          </Button>
          <Button variant="glass" size="sm" disabled={paged.page >= paged.pages} onClick={() => setPage(paged.page + 1)}>
            {t("adminTable.next")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
