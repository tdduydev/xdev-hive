import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { appendCrashLog, crashLogPath, ReloadGuard, rendererGoneText } from "#desktop/main/crashlog.ts";

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

  it("stops periodic OOM recovery even when each crash falls outside the rolling window", () => {
    const guard = new ReloadGuard(3, 5 * 60_000, 3);
    assert.deepEqual(Array.from({ length: 10 }, (_, n) => guard.allow(n * 315_000)), [true, true, true, false, false, false, false, false, false, false]);
    assert.equal(guard.allow(24 * 60 * 60_000), false, "time and reopening a window cannot replenish the session budget");
  });

  it("labels crash reason, exit code, last live memory sample age/units and recovery outcome", () => {
    const text = rendererGoneText({ reason: "crashed", exitCode: 133 }, { at: 1000, pid: 321, workingSetKB: 400_000, peakWorkingSetKB: 500_000 }, 100_000_000, "limit-reached", 31_000);
    assert.match(text, /crashed \(exit 133\)/);
    assert.match(text, /pid=321 sampleAgeMs=30000 workingSetKB=400000 peakWorkingSetKB=500000/);
    assert.match(text, /mainRSSBytes=100000000; recovery=limit-reached/);
    assert.match(rendererGoneText({ reason: "oom", exitCode: -1 }, null, 123, "reload-scheduled"), /lastRendererMemory=unavailable/);
  });
});
