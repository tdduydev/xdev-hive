import type { MergeQueueEntry, MergeQueueState } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { canManageMergeQueue, canRemoveMerge, canRetryMerge, externalUrl, splitMergeQueue } from "@/lib/merge-queue.ts";

function entry(state: MergeQueueState, position: number | null, finishedAt: string | null = null): MergeQueueEntry {
  return {
    id: state,
    projectId: "project",
    prNumber: 1,
    prUrl: null,
    branch: null,
    headSha: null,
    ciState: null,
    runId: null,
    taskId: null,
    state,
    note: null,
    position,
    mergeSha: null,
    enqueuedBy: "user",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    finishedAt,
  };
}

describe("merge queue actions", () => {
  it("only allows removal before merging and re-enqueue after failure/removal", () => {
    expect(
      ["queued", "updating", "waiting", "merging", "merged", "failed", "removed"].map((state) =>
        canRemoveMerge(state as MergeQueueState),
      ),
    ).toEqual([true, true, true, false, false, false, false]);
    expect(
      ["queued", "updating", "waiting", "merging", "merged", "failed", "removed"].map((state) =>
        canRetryMerge(state as MergeQueueState),
      ),
    ).toEqual([false, false, false, false, false, true, true]);
  });
  it("requires team membership or organization administration", () => {
    expect(canManageMergeQueue("owner", undefined)).toBe(true);
    expect(canManageMergeQueue("admin", "viewer")).toBe(true);
    expect(canManageMergeQueue("member", "admin")).toBe(true);
    expect(canManageMergeQueue("member", "member")).toBe(true);
    expect(canManageMergeQueue("member", "viewer")).toBe(false);
    expect(canManageMergeQueue("member", undefined)).toBe(false);
  });
  it("sorts the active queue by position and history by completion without modifying input", () => {
    const entries = [
      entry("failed", null, "2026-10-10T00:00:00Z"),
      entry("queued", 2),
      entry("merged", null, "2026-10-11T00:00:00Z"),
      entry("waiting", 1),
    ];
    const copy = [...entries];
    const result = splitMergeQueue(entries);
    expect(result.active.map((item) => item.state)).toEqual(["waiting", "queued"]);
    expect(result.finished.map((item) => item.state)).toEqual(["merged", "failed"]);
    expect(entries).toEqual(copy);
  });
  it("rejects executable and malformed external links", () => {
    expect(externalUrl("https://git.example.com/team/repo/pull/42")).toBe("https://git.example.com/team/repo/pull/42");
    for (const value of [null, "javascript:alert(1)", "data:text/html,test", "/projects", "bad url"])
      expect(externalUrl(value)).toBeUndefined();
  });
});
