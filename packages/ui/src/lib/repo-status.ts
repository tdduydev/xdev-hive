// What the Repo screen of a system says about each checkout (GROUP-repos-forge). Free of React, so a test reads it.
import type { RepoPullResult, RepoStatusRow } from "@xdev-hive/core";

/**
 * The last two folders of a path, with the path's own separator: "…\frontend\svc-portal" on Windows, never the
 * "…/frontend\svc-portal" a slash-only pattern made of a D:\ path.
 */
export function shortPath(dir: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : dir;
}

/** Where the checkout stands against its upstream, as a key and its count. */
export function remoteState(row: RepoStatusRow): { key: "detached" | "noUpstream" | "upToDate" | "ahead" | "behind" | "both"; ahead: number; behind: number } {
  if (!row.branch) return { key: "detached", ahead: 0, behind: 0 };
  if (!row.upstream) return { key: "noUpstream", ahead: 0, behind: 0 };
  const key = row.ahead && row.behind ? "both" : row.behind ? "behind" : row.ahead ? "ahead" : "upToDate";
  return { key, ahead: row.ahead, behind: row.behind };
}

/** Rows a Pull would change: behind, and nothing in the way. */
export const pullable = (rows: RepoStatusRow[]): RepoStatusRow[] => rows.filter((r) => !r.block && r.behind > 0);

export function pullCounts(results: RepoPullResult[]): Record<RepoPullResult["outcome"], number> {
  const counts = { pulled: 0, upToDate: 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  return counts;
}

/** The rows after a pull: each pulled repo's row as it is now, the others as they were. */
export function mergeRows(rows: RepoStatusRow[], results: RepoPullResult[]): RepoStatusRow[] {
  const after = new Map(results.map((r) => [r.project, r.row]));
  return rows.map((r) => after.get(r.project) ?? r);
}

export type Tone = "success" | "warning" | "danger" | "neutral";

export function accessTone(access: RepoStatusRow["access"]): Tone {
  if (access === "ok") return "success";
  if (access === "unchecked") return "neutral";
  if (access === "network" || access === "error") return "warning";
  return "danger";
}
