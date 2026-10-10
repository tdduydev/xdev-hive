import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fitBounds, markRelaunchWindow, RELAUNCH_WINDOW, takeRelaunchWindow } from "#desktop/main/window-state.ts";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-window-"));
  dirs.push(dir);
  return dir;
};
const t0 = Date.parse("2026-10-10T09:00:00Z");

describe("window across an update (BUG-update-hidden-window)", () => {
  it("brings back a shown window where it was, read once", () => {
    const dir = tmp();
    assert.equal(takeRelaunchWindow(dir, t0), null, "no marker: an ordinary start");
    const window = { visible: true, bounds: { x: 120, y: 80, width: 1400, height: 900 }, maximized: true, hash: "/tasks" };
    markRelaunchWindow(dir, window, t0);
    assert.deepEqual(takeRelaunchWindow(dir, t0 + 5_000), window);
    assert.equal(takeRelaunchWindow(dir, t0 + 6_000), null, "read once: a later start by hand is ordinary");
  });

  it("keeps a hidden window hidden, and a minimized one counts as shown", () => {
    const dir = tmp();
    markRelaunchWindow(dir, { visible: false, hash: "/chat" }, t0);
    assert.deepEqual(takeRelaunchWindow(dir, t0 + 1_000), { visible: false, hash: "/chat" });
    markRelaunchWindow(dir, { visible: true, minimized: true }, t0);
    assert.deepEqual(takeRelaunchWindow(dir, t0 + 1_000), { visible: true, minimized: true });
  });

  it("ignores a marker too old to trust or unreadable", () => {
    const dir = tmp();
    markRelaunchWindow(dir, { visible: true }, t0);
    assert.equal(takeRelaunchWindow(dir, t0 + 11 * 60_000), null, "a helper that never relaunched decides nothing later");
    writeFileSync(path.join(dir, RELAUNCH_WINDOW), "{not json");
    assert.equal(takeRelaunchWindow(dir, t0), null);
  });

  it("reads the bare timestamp of builds before it as a hidden start", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, RELAUNCH_WINDOW), String(t0));
    assert.deepEqual(takeRelaunchWindow(dir, t0 + 2_000), { visible: false });
  });

  it("drops bad bounds instead of opening a window of no size", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, RELAUNCH_WINDOW), JSON.stringify({ at: t0, visible: true, bounds: { x: 0, y: 0, width: 0, height: 500 } }));
    assert.deepEqual(takeRelaunchWindow(dir, t0), { visible: true });
  });
});

describe("fitBounds", () => {
  const main = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: 0, width: 2560, height: 1400 };

  it("keeps bounds that are on a screen", () => {
    const b = { x: 2100, y: 100, width: 1400, height: 900 };
    assert.deepEqual(fitBounds(b, [main, right]), b);
  });

  it("opens centred by default when the screen it was on is gone", () => {
    assert.equal(fitBounds({ x: 2100, y: 100, width: 1400, height: 900 }, [main]), undefined);
    assert.equal(fitBounds(undefined, [main]), undefined);
  });

  it("shrinks a window larger than a smaller remote desktop", () => {
    assert.deepEqual(fitBounds({ x: 0, y: 0, width: 2400, height: 1350 }, [{ x: 0, y: 0, width: 1280, height: 760 }]), { x: 0, y: 0, width: 1280, height: 760 });
  });

  it("wants a usable strip of title bar, not a corner", () => {
    assert.equal(fitBounds({ x: 1900, y: 1030, width: 1000, height: 700 }, [main]), undefined);
  });
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
