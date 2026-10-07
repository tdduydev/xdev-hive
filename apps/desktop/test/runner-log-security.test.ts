import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner } from "#desktop/main/runner/runner.ts";

it("refuses traversal in renderer run log requests", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-log-security-"));
  const hive = new SqliteHive(":memory:");
  const runner = new Runner({
    backend: () => hive, profiles: () => [], projects: () => [], mode: () => "local",
    machine: () => "test", env: () => ({}),
    settings: () => ({ maxParallel: 1, maxAttempts: 1, worktreeRoot: null, acceptHubRuns: false }),
  }, { dataDir, user: "test", chatPollMs: 0 });
  try {
    mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    writeFileSync(path.join(dataDir, "outside.log"), "outside sentinel");
    writeFileSync(path.join(dataDir, "runs", "R-test.log"), "run sentinel");
    assert.equal(runner.log("R-test"), "run sentinel");
    for (const id of ["../outside", "/tmp/outside", "..\\outside"]) {
      assert.throws(() => runner.log(id), { code: "bad_request" });
    }
  } finally {
    await runner.stop();
    runner.store.db.close();
    hive.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
