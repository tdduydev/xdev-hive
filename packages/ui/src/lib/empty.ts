// Why a list on the Knowledge pages (Tài liệu, Spec, Skill, Memory) shows nothing, so each page says the right thing
// (roadmap 39h). Kept apart from the pages because the three cases are easy to get backwards and worth a test.

/** `none`: nothing written yet. `noMatch`: a search found nothing. `noFilter`: a filter chip hides every row. */
export type EmptyKind = "none" | "noMatch" | "noFilter";

/**
 * Only an empty collection is a to-do, so only `none` deserves a "create the first one" button: when a search or a
 * filter is what empties the screen, the way out is to widen it. `total` counts the rows the page holds (for a search
 * the hub ran, the results), `shown` those left after the page's own search box and filter chips.
 */
export function emptyState({
  loaded,
  total,
  shown,
  query,
  filtered,
}: {
  loaded: boolean;
  total: number;
  shown: number;
  /** The search box, as submitted. */
  query?: string;
  /** A filter chip other than "all" is on. */
  filtered?: boolean;
}): EmptyKind | null {
  if (!loaded || shown > 0) return null;
  // Rows came back and something on this page hides them: the filter chip first, as it is the narrower of the two.
  if (total > 0) return filtered ? "noFilter" : "noMatch";
  if (query) return "noMatch";
  return "none";
}
