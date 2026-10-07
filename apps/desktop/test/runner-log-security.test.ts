import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner, redactedRunLog } from "#desktop/main/runner/runner.ts";

it("refuses traversal in renderer run log requests", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-log-security-"));
  const hive = new SqliteHive(":memory:");
  const runner = new Runner({
    backend: () => hive, profiles: () => [], projects: () => [], mode: () => "local",
    machine: () => "test", env: () => ({}),
    settings: () => ({ maxParallel: 1, maxAttempts: 1, worktreeRoot: null, acceptHubRuns: false, gateRunner: false }),
  }, { dataDir, user: "test", chatPollMs: 0 });
  try {
    mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    writeFileSync(path.join(dataDir, "outside.log"), "outside sentinel");
    writeFileSync(path.join(dataDir, "runs", "R-test.log"), "run sentinel");
    assert.equal(runner.log("R-test"), "run sentinel");
    const raw = `before\n-----BEGIN PRIVATE KEY-----\n${"synthetic material\n".repeat(100)}-----END PRIVATE KEY-----\nafter`;
    writeFileSync(path.join(dataDir, "runs", "R-old.log"), raw);
    assert.ok(!runner.log("R-old", 200).includes("synthetic material"));
    assert.ok(runner.log("R-old", 200).endsWith("after"));
    writeFileSync(path.join(dataDir, "runs", "R-token.log"), `hive_${"a".repeat(43)}`);
    assert.ok(!runner.log("R-token").includes("a".repeat(43)));
    writeFileSync(path.join(dataDir, "runs", "R-open.log"), "-----BEGIN PRIVATE KEY-----\nsynthetic material");
    assert.ok(!runner.log("R-open", 20).includes("material"));
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


it("writes only redacted prompt and output even with byte-sized chunks", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-log-writer-"));
  const file = path.join(dir, "run.log");
  const writer = redactedRunLog(file);
  try {
    const text = `## Prompt\nhive_${"a".repeat(43)}\n## Output\n-----BEGIN PRIVATE KEY-----\nsynthetic material\n-----END PRIVATE KEY-----\nnormal é\n`;
    for (const byte of Buffer.from(text)) writer.write(Buffer.from([byte]));
    await new Promise<void>((resolve, reject) => { writer.on("error", reject); writer.end(resolve); });
    const saved = readFileSync(file, "utf8");
    assert.ok(!saved.includes("a".repeat(43)));
    assert.ok(!saved.includes("synthetic material"));
    assert.ok(saved.endsWith("normal é\n"));
  } finally { writer.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
