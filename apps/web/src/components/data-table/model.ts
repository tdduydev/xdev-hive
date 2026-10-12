export type Value = string | number | null | undefined;
export type Filters = Readonly<Record<string, readonly string[]>>;
export interface Sort {
  key: string;
  direction: "asc" | "desc";
}
export interface SearchColumn<Row> {
  key: string;
  value: (row: Row) => Value;
}
export interface Facet<Row> {
  key: string;
  label: string;
  value: (row: Row) => string | readonly string[] | null | undefined;
  options?: readonly { value: string; label: string }[];
}
export interface FilterState {
  query: string;
  filters: Filters;
}

function values<Row>(row: Row, facet: Facet<Row>): readonly string[] {
  const value = facet.value(row);
  return value == null ? [] : typeof value === "string" ? [value] : value;
}

export function filterRows<Row>(
  rows: readonly Row[],
  columns: readonly SearchColumn<Row>[],
  facets: readonly Facet<Row>[],
  state: FilterState,
  skipFacet?: string,
): Row[] {
  const query = state.query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!query ||
        columns.some((column) =>
          String(column.value(row) ?? "")
            .toLocaleLowerCase()
            .includes(query),
        )) &&
      facets.every((facet) => {
        const chosen = state.filters[facet.key] ?? [];
        return facet.key === skipFacet || !chosen.length || values(row, facet).some((value) => chosen.includes(value));
      }),
  );
}

/** A facet ignores its own selection so the remaining alternatives keep meaningful counts. */
export function facetOptions<Row>(
  rows: readonly Row[],
  columns: readonly SearchColumn<Row>[],
  facets: readonly Facet<Row>[],
  state: FilterState,
  facet: Facet<Row>,
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of filterRows(rows, columns, facets, state, facet.key)) {
    for (const value of new Set(values(row, facet))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const options = new Map((facet.options ?? []).map((option) => [option.value, option.label]));
  for (const row of rows)
    for (const value of values(row, facet)) if (value) options.set(value, options.get(value) ?? value);
  for (const value of state.filters[facet.key] ?? []) if (!options.has(value)) options.set(value, value);
  return [...options].map(([value, label]) => ({ value, label, count: counts.get(value) ?? 0 }));
}

/** Missing measurements always stay at the end, including when sorting descending. */
export function sortRows<Row>(rows: readonly Row[], columns: readonly SearchColumn<Row>[], sort: Sort | null): Row[] {
  const column = columns.find((column) => column.key === sort?.key);
  if (!sort || !column) return [...rows];
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (
      (typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true })) * multiplier
    );
  });
}

export function paginateRows<Row>(rows: readonly Row[], requestedPage: number, requestedSize: number) {
  const size = Number.isFinite(requestedSize) ? Math.max(1, Math.floor(requestedSize)) : 10;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Number.isFinite(requestedPage) ? Math.max(0, Math.min(Math.floor(requestedPage), pages - 1)) : 0;
  return {
    rows: rows.slice(page * size, (page + 1) * size),
    page,
    pages,
    from: rows.length ? page * size + 1 : 0,
    to: Math.min(rows.length, (page + 1) * size),
    total: rows.length,
  };
}
