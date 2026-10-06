import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MainLog, mainLogDir, markStartHidden, QuitReasons, relaunchAfterQuitInstall, takeStartHidden, type QuitReason } from "#desktop/main/applog.ts";

describe("main.log (BUG-update-relaunch)", () => {
  it("lives where each OS keeps logs", () => {
    assert.equal(mainLogDir("darwin", {}, "/Users/a"), "/Users/a/Library/Logs/xDev Hive");
    assert.equal(mainLogDir("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a"), path.join("C:\\Users\\a\\AppData\\Roaming", "xDev Hive", "logs"));
    assert.equal(mainLogDir("linux", {}, "/home/a"), "/home/a/.config/xDev Hive/logs");
    assert.equal(mainLogDir("linux", { XDG_STATE_HOME: "/home/a/.local/state" }, "/home/a"), "/home/a/.local/state/xDev Hive/logs");
    assert.equal(mainLogDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/a"), "/cfg/xDev Hive/logs");
  });

  it("writes one timestamped line per event and rotates, keeping 3 old files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-mainlog-"));
    const file = path.join(dir, "logs", "main.log");
    const log = new MainLog(file, { maxBytes: 100, now: () => new Date("2026-10-06T03:27:59Z") });
    log.write("start 0.133.0\npid 1");
    assert.equal(readFileSync(file, "utf8"), "[2026-10-06T03:27:59.000Z] start 0.133.0 pid 1\n", "one line, even for text with newlines");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `old ${i} ${"x".repeat(200)}`);
      log.write(`line ${i}`);
    }
    assert.match(readFileSync(file, "utf8"), /line 4\n$/);
    assert.match(readFileSync(`${file}.1`, "utf8"), /^old 4/);
    assert.match(readFileSync(`${file}.3`, "utf8"), /^old 2/);
    assert.equal(existsSync(`${file}.4`), false, "never more than 3 old files");
  });

  it("never throws when the log cannot be written", () => {
    assert.doesNotThrow(() => new MainLog("/dev/null/no/such/dir/main.log").write("x"));
  });

  it("says why the app quit, the first cause winning", () => {
    const none = new QuitReasons();
    assert.equal(none.reason, "unknown");
    assert.equal(none.describe(), "quit: unknown");

    const tray = new QuitReasons();
    tray.mark("user", "tray");
    assert.equal(tray.describe(), "quit: user (tray)");

    // macOS: the shutdown notice comes first, then the system quits the app.
    const shutdown = new QuitReasons();
    shutdown.mark("shutdown", "powerMonitor");
    shutdown.mark("unknown", "all windows closed");
    assert.equal(shutdown.reason, "shutdown");
    assert.equal(shutdown.describe(), "quit: shutdown (powerMonitor)");

    const signal = new QuitReasons();
    signal.mark("signal", "SIGTERM");
    assert.equal(signal.describe(), "quit: signal (SIGTERM)");
  });
});

describe("relaunch after an install at quit", () => {
  it("starts a machine that takes work again, unless the person quit or the computer shuts down", () => {
    const table: [QuitReason, boolean, boolean][] = [
      ["unknown", true, true],
      ["signal", true, true],
      ["update", true, true],
      ["user", true, false],
      ["shutdown", true, false],
      ["unknown", false, false],
      ["signal", false, false],
      ["user", false, false],
      ["shutdown", false, false],
    ];
    for (const [reason, takesWork, want] of table) assert.equal(relaunchAfterQuitInstall(reason, takesWork), want, `${reason}, takes work ${takesWork}`);
  });

  it("opens hidden through a marker read once, and only soon after the install", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-hidden-"));
    const t0 = Date.parse("2026-10-06T03:28:00Z");
    assert.equal(takeStartHidden(dir, t0), false, "no marker: a normal start");
    markStartHidden(dir, t0);
    assert.equal(takeStartHidden(dir, t0 + 5_000), true);
    assert.equal(takeStartHidden(dir, t0 + 6_000), false, "read once: the next start shows its window");
    markStartHidden(dir, t0);
    assert.equal(takeStartHidden(dir, t0 + 11 * 60_000), false, "a helper that never relaunched must not hide a window opened later by hand");
  });
});
