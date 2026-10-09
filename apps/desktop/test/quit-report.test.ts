import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { HubBackend, HiveError } from "@xdev-hive/core";
import { RunStore } from "#desktop/main/runner/store.ts";
import { Runner, type RunnerHost } from "#desktop/main/runner/runner.ts";
import type { RunnerSettings } from "@xdev-hive/core";

it("persists a quit-aborted task report and replays it on restart with the same idempotency key", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-quit-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "runs.db");
  const first = new RunStore(file);
  const hub = new HubBackend("https://stall.test", "token");
  hub.setQuitQueue((id, method, input, actor) => first.queueHubReport(id, method, input, actor));
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const input = { id: "T-1", status: "review" as const, note: "WIP committed" };
  const actor = { name: "runner", role: "agent" as const };
  const pending = hub.call("tasks.update", input, actor);
  hub.stopForQuit();
  await assert.rejects(pending, (err: unknown) => err instanceof HiveError && err.code === "unavailable");
  assert.equal(first.pendingHubReports().length, 1);
  first.db.close();

  const opened = new RunStore(file);
  const report = opened.pendingHubReports()[0]!;
  opened.db.close();
  const seen: string[] = [];
  t.mock.restoreAll();
  let supported = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/me")) return Response.json({ result: {} }, { headers: supported ? { "x-hive-report-idempotency": "1" } : {} });
    seen.push(new Headers(init.headers).get("x-hive-idempotency") ?? "");
    return Response.json({ result: { id: "T-1" } });
  });
  const restartedHub = new HubBackend("https://stall.test", "token");
  const host = {
    backend: () => restartedHub, profiles: () => [], settings: () => ({} as RunnerSettings), projects: () => [],
    mode: () => "hub" as const, machine: () => "machine", env: () => ({}),
  } satisfies RunnerHost;
  const restarted = new Runner(host, { dataDir: dir });
  t.after(() => restarted.store.db.close());
  await assert.rejects(restarted.flushHubReports(), (err: unknown) => err instanceof HiveError && err.code === "unavailable");
  assert.equal(restarted.store.pendingHubReports().length, 1, "an old hub cannot deduplicate the replay");
  supported = true;
  await restarted.flushHubReports();
  assert.deepEqual(seen, [report.id]);
  assert.deepEqual(restarted.store.pendingHubReports(), []);
});
