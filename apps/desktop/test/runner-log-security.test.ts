import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { Runner, appendRedactedRunLog, redactedRunLog } from "#desktop/main/runner/runner.ts";
import { readLegacyRunLogTail, readRunLogTail } from "#desktop/main/runner/run-logs.ts";

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
    assert.ok(!(await runner.logRecent("R-old", 200)).includes("synthetic material"));
    assert.ok(!(await runner.logRecent("R-open", 20)).includes("material"));
    assert.ok(!(await runner.logRecent("R-token")).includes("a".repeat(43)));
    assert.equal(await runner.logRecent("R-test"), "run sentinel");
    writeFileSync(path.join(dataDir, "runs", "R-test.log"), "changed run sentinel");
    assert.equal(await runner.logRecent("R-test"), "changed run sentinel", "size changes invalidate the tail cache");
    for (const id of ["../outside", "/tmp/outside", "..\\outside"]) {
      assert.throws(() => runner.log(id), { code: "bad_request" });
      await assert.rejects(runner.logRecent(id), { code: "bad_request" });
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

it("reads only a marked log suffix and invalidates the cache when its mtime changes", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "hive-log-tail-"));
  const hive = new SqliteHive(":memory:");
  const runner = new Runner({
    backend: () => hive, profiles: () => [], projects: () => [], mode: () => "local",
    machine: () => "test", env: () => ({}),
    settings: () => ({ maxParallel: 1, maxAttempts: 1, worktreeRoot: null, acceptHubRuns: false, gateRunner: false }),
  }, { dataDir, user: "test", chatPollMs: 0 });
  try {
    mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    const file = path.join(dataDir, "runs", "R-long.log");
    const writer = redactedRunLog(file);
    writer.end(`${"old line\n".repeat(100_000)}last line\n`);
    await new Promise<void>((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
    assert.ok(readFileSync(`${file}.redacted`).length === 0);
    assert.ok((await runner.logRecent("R-long", 80)).includes("last line"));
    assert.ok((await runner.logRecent("R-long", 80)).length < 150);
    writeFileSync(file, `${"old line\n".repeat(100_000)}next line\n`);
    utimesSync(file, new Date("2026-01-01"), new Date("2026-01-01"));
    assert.ok((await runner.logRecent("R-long", 80)).includes("next line"));
  } finally {
    await runner.stop(); runner.store.db.close(); hive.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

it("keeps the suffix of a single line longer than the read window", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-log-line-"));
  try {
    const file = path.join(dir, "long.log");
    writeFileSync(file, `${"x".repeat(100_000)}THE-END`);
    const tail = await readRunLogTail(file, 48_000);
    assert.ok(tail.text.endsWith("THE-END"));
    assert.ok(tail.text.length >= 48_000);
    assert.ok((await readLegacyRunLogTail(file, 48_000)).text.endsWith("THE-END"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("redacts PEM material split between append calls and again at the read boundary", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-log-split-"));
  try {
    const file = path.join(dir, "split.log");
    appendRedactedRunLog(file, "-----BEGIN PRIVATE KEY-----\n");
    appendRedactedRunLog(file, "synthetic material\n-----END PRIVATE KEY-----\nafter\n");
    assert.doesNotMatch(readFileSync(file, "utf8"), /synthetic material/);
    assert.doesNotMatch((await readRunLogTail(file, 48_000)).text, /synthetic material/);
    // A marked file may have been written by an older, chunk-local writer.
    writeFileSync(file, "-----BEGIN PRIVATE KEY-----\nsynthetic material\n-----END PRIVATE KEY-----\nafter\n");
    const tail = await readRunLogTail(file, 48_000);
    assert.doesNotMatch(tail.text, /synthetic material/);
    assert.match(tail.text, /after/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("hides a legacy PEM body whose BEGIN is outside the bounded suffix", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-log-old-pem-"));
  try {
    const file = path.join(dir, "old.log");
    writeFileSync(file, `-----BEGIN PRIVATE KEY-----\n${"synthetic material\n".repeat(1000)}-----END PRIVATE KEY-----\nafter\n`);
    const tail = await readLegacyRunLogTail(file, 200);
    assert.doesNotMatch(tail.text, /synthetic material/);
    assert.match(tail.text, /after/);
    assert.ok(tail.text.length < 300);
    writeFileSync(file, `-----BEGIN PRIVATE KEY-----\n${`${"A".repeat(64)}\n`.repeat(1000)}`);
    assert.doesNotMatch((await readLegacyRunLogTail(file, 200)).text, /A{20}/,
      "an open legacy PEM block must not expose base64 lines or a partial boundary line");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
