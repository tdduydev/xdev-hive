import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pruneRunLogs } from "#desktop/main/runner/run-logs.ts";
import { pruneLinuxVersions } from "#desktop/main/linux-update.ts";

describe("machine data cleanup (DATA-cleanup-machine)", () => {
  it("removes run logs and plans untouched for the retention, never an active run's or another file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-run-logs-"));
    try {
      const now = new Date("2026-10-07T00:00:00Z");
      const old = new Date(+now - 40 * 86400_000);
      for (const name of ["R-old.log", "R-old.plan.md", "R-busy.log", "R-new.log", "R-old.mcp.json", "notes.txt"]) {
        writeFileSync(path.join(dir, name), "x".repeat(10));
        if (name !== "R-new.log") utimesSync(path.join(dir, name), old, old);
      }
      assert.deepEqual(pruneRunLogs(dir, 30, now, new Set(["R-busy"])), { removed: 2, bytes: 20 });
      assert.deepEqual(readdirSync(dir).sort(), ["R-busy.log", "R-new.log", "R-old.mcp.json", "notes.txt"]);
      assert.deepEqual(pruneRunLogs(path.join(dir, "missing"), 30, now, new Set()), { removed: 0, bytes: 0 }, "no runs folder yet");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps the running app version and the newest one below it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hive-runtime-"));
    try {
      for (const v of ["0.135.0", "0.142.0", "0.143.0", "0.145.1", "0.145.2"]) mkdirSync(path.join(root, `app-${v}`));
      writeFileSync(path.join(root, "xdev-hive.AppImage"), "");
      const app = path.join(root, "app-0.145.1");
      symlinkSync(app, path.join(root, "current"));
      // 0.145.2 is newer than the running one: an extract whose switch failed, not something to fall back to.
      assert.deepEqual(pruneLinuxVersions({ root, app, current: path.join(root, "current") }).sort(), ["app-0.135.0", "app-0.142.0", "app-0.145.2"]);
      assert.deepEqual(readdirSync(root).sort(), ["app-0.143.0", "app-0.145.1", "current", "xdev-hive.AppImage"]);
      assert.ok(existsSync(app));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
