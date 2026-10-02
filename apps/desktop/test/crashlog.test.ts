import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { appendCrashLog, crashLogPath, ReloadGuard } from "#desktop/main/crashlog.ts";

describe("crash log (white window, asked 2/10)", () => {
  it("appends timestamped entries under logs/ and moves a full file aside", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-crashlog-"));
    const file = crashLogPath(dir);
    appendCrashLog(file, "renderer: TypeError: x is undefined", new Date("2026-10-02T05:00:00Z"));
    assert.match(readFileSync(file, "utf8"), /^\[2026-10-02T05:00:00.000Z\] renderer: TypeError: x is undefined\n/);
    writeFileSync(file, "x".repeat(1_000_001));
    appendCrashLog(file, "render-process-gone: oom (exit 0)");
    assert.equal(existsSync(`${file}.1`), true, "the full one is kept once");
    assert.match(readFileSync(file, "utf8"), /render-process-gone: oom/);
    assert.equal(readFileSync(file, "utf8").length < 200, true);
  });

  it("never throws when the log cannot be written", () => {
    assert.doesNotThrow(() => appendCrashLog("/dev/null/no/such/dir/renderer.log", "x"));
  });

  it("reloads a dead window at most 3 times in 5 minutes", () => {
    const guard = new ReloadGuard();
    const t0 = Date.parse("2026-10-02T05:00:00Z");
    assert.deepEqual([guard.allow(t0), guard.allow(t0 + 1000), guard.allow(t0 + 2000), guard.allow(t0 + 3000)], [true, true, true, false]);
    assert.equal(guard.allow(t0 + 5 * 60_000 + 1), true, "the first fell out of the window");
  });
});
