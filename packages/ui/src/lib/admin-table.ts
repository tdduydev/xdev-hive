// Pure search / filter / sort / page of the AdminTable rows (pages/admin/cosmic.tsx), apart so it is tested without React.
// Done in the browser: every list that uses it is already fetched whole (the audit asks the hub for its newest 300).
export type SortDir = "asc" | "desc";
export type SortValue = string | number | null | undefined;

export interface TableItem {
  /** One value per column, same order as `cols`; a column with none for any row is not sortable. */
  sort?: SortValue[];
  /** Plain text the search box matches (cells hold nodes, so the caller says what is searchable). */
  search?: string;
  /** Value per filter key, matched exactly. */
  tags?: Record<string, string>;
}

export const TABLE_PAGE_SIZE = 25;

export function filterItems<T extends TableItem>(items: T[], query: string, active: Record<string, string>): T[] {
  const q = query.trim().toLowerCase();
  const entries = Object.entries(active).filter(([, v]) => v !== "");
  return items.filter((r) => (!q || (r.search ?? "").toLowerCase().includes(q)) && entries.every(([k, v]) => r.tags?.[k] === v));
}

/** Empty values go last in both directions; ties keep the incoming order so a click never shuffles equal rows. */
export function sortItems<T extends TableItem>(items: T[], col: number | null, dir: SortDir): T[] {
  if (col === null) return items;
  const sign = dir === "asc" ? 1 : -1;
  const blank = (v: SortValue) => v === null || v === undefined || v === "";
  return items
    .map((r, i) => ({ r, i, v: r.sort?.[col] }))
    .sort((a, b) => {
      if (blank(a.v) || blank(b.v)) return blank(a.v) === blank(b.v) ? a.i - b.i : blank(a.v) ? 1 : -1;
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
      return c ? c * sign : a.i - b.i;
    })
    .map((x) => x.r);
}

export interface Page<T> { rows: T[]; page: number; pages: number; from: number; to: number; total: number }
/** `page` is 1-based and clamped, so a filter that shrinks the list never leaves an empty page. */
export function pageItems<T>(items: T[], page: number, size = TABLE_PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * size;
  const rows = items.slice(start, start + size);
  return { rows, page: p, pages, from: rows.length ? start + 1 : 0, to: start + rows.length, total: items.length };
}
