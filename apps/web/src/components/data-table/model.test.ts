import { describe, expect, it } from "vitest";
import { type Facet, facetOptions, filterRows, paginateRows, sortRows } from "./model.ts";

const rows = [
  { id: "r1", title: "VAT invoice", cli: "claude", tags: ["running", "running"], cost: 10 },
  { id: "r2", title: "Proxy", cli: "codex", tags: ["failed"], cost: 2 },
  { id: "r3", title: "VAT round", cli: "codex", tags: ["running", "review"], cost: null },
];
const columns = [
  { key: "title", value: (row: (typeof rows)[number]) => row.title },
  { key: "cost", value: (row: (typeof rows)[number]) => row.cost },
];
const facets = [
  { key: "cli", label: "Agent", value: (row: (typeof rows)[number]) => row.cli },
  { key: "tags", label: "Status", value: (row: (typeof rows)[number]) => row.tags },
] as const satisfies readonly Facet<(typeof rows)[number]>[];

describe("data table model", () => {
  it("combines case-insensitive search, OR within a facet and AND between facets", () => {
    expect(
      filterRows(rows, columns, facets, { query: "  vat ", filters: { cli: ["codex"], tags: ["running", "failed"] } }),
    ).toEqual([rows[2]]);
    expect(filterRows(rows, columns, facets, { query: "", filters: { tags: ["running", "failed"] } })).toEqual(rows);
    expect(filterRows(rows, columns, facets, { query: "missing", filters: {} })).toEqual([]);
  });
  it("counts alternative facet values against other filters and counts each row only once", () => {
    const state = { query: "vat", filters: { cli: ["claude"], tags: ["running"] } };
    expect(facetOptions(rows, columns, facets, state, facets[0])).toEqual([
      { value: "claude", label: "claude", count: 1 },
      { value: "codex", label: "codex", count: 1 },
    ]);
    expect(facetOptions(rows, columns, facets, state, facets[1])).toEqual([
      { value: "running", label: "running", count: 1 },
      { value: "failed", label: "failed", count: 0 },
      { value: "review", label: "review", count: 0 },
    ]);
  });
  it("retains zero-count and stale selected options so they can be cleared", () => {
    expect(
      facetOptions(rows, columns, facets, { query: "absent", filters: { cli: ["old"] } }, facets[0]).at(-1),
    ).toEqual({ value: "old", label: "old", count: 0 });
  });
  it("sorts numeric values, keeps null last, remains stable and never mutates input", () => {
    const original = [...rows];
    expect(sortRows(rows, columns, { key: "cost", direction: "asc" }).map((row) => row.id)).toEqual(["r2", "r1", "r3"]);
    expect(sortRows(rows, columns, { key: "cost", direction: "desc" }).map((row) => row.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(sortRows(rows, [{ key: "same", value: () => 1 }], { key: "same", direction: "desc" })).toEqual(rows);
    expect(sortRows(rows, columns, { key: "absent", direction: "asc" })).toEqual(rows);
    expect(rows).toEqual(original);
  });
  it("clamps stale pages after filtering and reports the last partial page", () => {
    expect(paginateRows(rows, 9, 2)).toEqual({ rows: [rows[2]], page: 1, pages: 2, from: 3, to: 3, total: 3 });
    expect(paginateRows([], 8, 10)).toEqual({ rows: [], page: 0, pages: 1, from: 0, to: 0, total: 0 });
    expect(paginateRows(rows, -1, 0).rows).toEqual([rows[0]]);
    expect(paginateRows(rows, Number.NaN, Number.NaN).rows).toEqual(rows);
  });
});
