import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoPullResult, RepoStatusRow } from "@xdev-hive/core";
import { accessTone, mergeRows, pullable, pullCounts, remoteState, shortPath } from "#ui/lib/repo-status.ts";

const row = (project: string, over: Partial<RepoStatusRow> = {}): RepoStatusRow => ({
  project, repo: `/r/${project}`, exists: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, changes: 0, conflicts: 0,
  remote: null, forge: null, webUrl: null, access: "unchecked", accessDetail: null, fetchedAt: null, busy: null, block: null, ...over,
});

test("a path's last two folders keep its own separator", () => {
  assert.equal(shortPath("D:\\Codes\\customer-ai\\his\\frontend\\svc-portal"), "…\\frontend\\svc-portal");
  assert.equal(shortPath("/home/duy/ehs/his/backend/api"), "…/backend/api");
  assert.equal(shortPath("D:\\x"), "D:\\x");
});

test("where a checkout stands against its upstream", () => {
  assert.equal(remoteState(row("a", { branch: null })).key, "detached");
  assert.equal(remoteState(row("a", { upstream: null })).key, "noUpstream");
  assert.equal(remoteState(row("a")).key, "upToDate");
  assert.deepEqual(remoteState(row("a", { behind: 2 })), { key: "behind", ahead: 0, behind: 2 });
  assert.equal(remoteState(row("a", { ahead: 1, behind: 1 })).key, "both");
});

test("Pull all offers only the clean repos that are behind", () => {
  const rows = [row("a", { behind: 1 }), row("b", { behind: 1, block: "dirty" }), row("c"), row("d", { ahead: 3 })];
  assert.deepEqual(pullable(rows).map((r) => r.project), ["a"]);
});

test("a pull's results replace only the rows they are about", () => {
  const rows = [row("a", { behind: 1 }), row("b", { behind: 1, block: "dirty" })];
  const results: RepoPullResult[] = [
    { project: "a", outcome: "pulled", reason: null, error: null, row: row("a") },
    { project: "b", outcome: "skipped", reason: "dirty", error: null, row: row("b", { behind: 1, block: "dirty" }) },
  ];
  assert.deepEqual(mergeRows(rows, results.slice(0, 1)).map((r) => r.behind), [0, 1]);
  assert.deepEqual(pullCounts(results), { pulled: 1, upToDate: 0, skipped: 1, failed: 0 });
});

test("access tones: readable, unknown, the network's fault, refused", () => {
  assert.deepEqual((["ok", "unchecked", "network", "no_access", "no_access_or_missing"] as const).map(accessTone), ["success", "neutral", "warning", "danger", "danger"]);
});
