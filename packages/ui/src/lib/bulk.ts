// Bulk approve on the Proposals and Memory pages (roadmap 18e): which picked items can go, which are skipped, and
// running them one by one with the existing single-item methods so one conflict does not stop the rest.
import type { Memory, Proposal } from "@xdev-hive/core";

export interface Split<T> {
  ready: T[];
  /** Skipped and left as they are, for a person to look at one by one. */
  conflicts: T[];
}

/**
 * Proposals to approve, oldest first. Skipped: a proposal whose doc has moved past its base version (versions known), and
 * every later picked proposal on a doc that an earlier one already changes, since approving that one moves the doc.
 * Skipping instead of letting the hub mark them "conflict" keeps them pending, so the person can still pick which one wins.
 */
export function splitProposals(picked: Proposal[], versions?: ReadonlyMap<string, number>): Split<Proposal> {
  const out: Split<Proposal> = { ready: [], conflicts: [] };
  const taken = new Set<string>();
  for (const p of [...picked].filter((p) => p.status === "pending").sort((a, b) => a.id - b.id)) {
    const current = versions ? (versions.get(p.docKey) ?? 0) : p.baseVersion;
    if (current !== p.baseVersion || taken.has(p.docKey)) out.conflicts.push(p);
    else {
      taken.add(p.docKey);
      out.ready.push(p);
    }
  }
  return out;
}

/** Pending entries to approve; one that disagrees with another entry waits for a person to choose between them. */
export function splitMemory(picked: Memory[]): Split<Memory> {
  const out: Split<Memory> = { ready: [], conflicts: [] };
  for (const m of picked) {
    if (m.status !== "pending") continue;
    (m.conflictsWith.length ? out.conflicts : out.ready).push(m);
  }
  return out;
}

export interface BulkResult<T> {
  done: T[];
  conflicts: T[];
  failed: Array<{ item: T; error: unknown }>;
}

const isConflict = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "conflict";

/**
 * Runs `step` on each item in turn (not in parallel: approving one doc version must land before the next is checked).
 * `step` returns "conflict" when the hub decided so (a proposal it marked conflict); a thrown conflict error counts the same.
 * Any other error is kept and the rest still run.
 */
export async function runBulk<T>(items: T[], step: (item: T) => Promise<"done" | "conflict">): Promise<BulkResult<T>> {
  const out: BulkResult<T> = { done: [], conflicts: [], failed: [] };
  for (const item of items) {
    try {
      if ((await step(item)) === "conflict") out.conflicts.push(item);
      else out.done.push(item);
    } catch (error) {
      if (isConflict(error)) out.conflicts.push(item);
      else out.failed.push({ item, error });
    }
  }
  return out;
}
