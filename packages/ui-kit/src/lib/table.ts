// Helpers of the data table (components/DataTable.tsx).

/** Page numbers to show: 1 … 4 5 6 … 12, at most seven entries. */
export function pagesToShow(page: number, count: number): Array<number | "…"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const out: Array<number | "…"> = [0];
  const from = Math.max(1, Math.min(page - 1, count - 4));
  const to = Math.min(count - 2, Math.max(page + 1, 3));
  if (from > 1) out.push("…");
  for (let i = from; i <= to; i++) out.push(i);
  if (to < count - 2) out.push("…");
  out.push(count - 1);
  return out;
}
