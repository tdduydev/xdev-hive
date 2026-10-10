import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { envForSession, parseSecondInstanceData, sameSession, secondInstanceAction, selfCommand, sessionEnv, SWITCH_WHEN_IDLE, waitHandoff, writeHandoff, type SessionEnv } from "#desktop/main/session.ts";

const dirs: string[] = [];

// The machine of the report: GNOME Wayland on seat0, and xfce over xrdp on Xorg :10.
const wayland: SessionEnv = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_SESSION_TYPE: "wayland", XDG_RUNTIME_DIR: "/run/user/1000" };
const xrdp: SessionEnv = { DISPLAY: ":10", XDG_SESSION_ID: "c7", XDG_SESSION_TYPE: "x11", XAUTHORITY: "/home/u/.Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-xrdp", XDG_RUNTIME_DIR: "/run/user/1000" };

describe("which session (BUG-update-hidden-window)", () => {
  it("takes only the session keys from the environment", () => {
    assert.deepEqual(sessionEnv({ ...xrdp, PATH: "/usr/bin", HOME: "/home/u", WAYLAND_DISPLAY: "" }), xrdp);
  });

  it("compares session ids when both have one, else the displays", () => {
    assert.equal(sameSession(wayland, xrdp), false);
    assert.equal(sameSession({ ...wayland }, { ...wayland, XDG_SESSION_ID: "2" }), true, "GNOME's menu start lacks the id; a terminal start in the same session has it");
    assert.equal(sameSession({ ...wayland, XDG_SESSION_ID: "2" }, { ...wayland, XDG_SESSION_ID: "3" }), false);
    assert.equal(sameSession(xrdp, { DISPLAY: ":10" }), true);
  });

  it("parses what a second start sends, and nothing from an older build", () => {
    assert.equal(parseSecondInstanceData(undefined), null);
    assert.equal(parseSecondInstanceData({}), null);
    assert.deepEqual(parseSecondInstanceData({ pid: 42, session: { DISPLAY: ":10", PATH: "/x", XAUTHORITY: 7 } }), { pid: 42, session: { DISPLAY: ":10" } });
    assert.deepEqual(parseSecondInstanceData({ pid: 42, session: {}, switchWhenIdle: true }), { pid: 42, session: {}, switchWhenIdle: true });
  });
});

describe("secondInstanceAction", () => {
  const act = (o: Partial<Parameters<typeof secondInstanceAction>[0]>) =>
    secondInstanceAction({ platform: "linux", mine: wayland, theirs: { pid: 9, session: xrdp }, busy: false, ...o });

  it("shows the window as before in the same session, off Linux, or without data", () => {
    assert.equal(act({ theirs: { pid: 9, session: wayland } }), "show");
    assert.equal(act({ platform: "win32" }), "show");
    assert.equal(act({ platform: "darwin" }), "show");
    assert.equal(act({ theirs: null }), "show");
    assert.equal(act({ theirs: { pid: 9, session: { XDG_SESSION_ID: "5" } } }), "show", "no display (ssh): nothing to move to");
  });

  it("moves when nothing would be cut short", () => {
    assert.equal(act({}), "move");
    assert.equal(act({ theirs: { pid: 9, session: xrdp, switchWhenIdle: true } }), "move");
  });

  it("tells the new session while runs go, and queues the move once asked", () => {
    assert.equal(act({ busy: true }), "busy");
    assert.equal(act({ busy: true, theirs: { pid: 9, session: xrdp, switchWhenIdle: true } }), "queue");
  });
});

describe("starting in the other session", () => {
  it("swaps every session key, dropping those the target lacks", () => {
    const env = envForSession({ ...wayland, PATH: "/usr/bin", XDG_SESSION_ID: "2" }, xrdp);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.DISPLAY, ":10");
    assert.equal(env.XDG_SESSION_ID, "c7");
    assert.equal(env.XAUTHORITY, "/home/u/.Xauthority");
    assert.equal("WAYLAND_DISPLAY" in env, false, "left set, Electron would open on the Wayland session again");
  });

  it("starts the AppImage file and drops the start-only flags", () => {
    assert.deepEqual(selfCommand("/tmp/.mount_x/xdev-hive", ["/tmp/.mount_x/xdev-hive", "--hidden", SWITCH_WHEN_IDLE, "--foo"], { APPIMAGE: "/home/u/xDev-Hive.AppImage" }), { file: "/home/u/xDev-Hive.AppImage", args: ["--foo"] });
    assert.deepEqual(selfCommand("/opt/xDev Hive/xdev-hive", ["/opt/xDev Hive/xdev-hive"], {}), { file: "/opt/xDev Hive/xdev-hive", args: [] });
  });

  it("hands the answer over through a file the second start waits for", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hive-handoff-"));
    dirs.push(dir);
    assert.equal(await waitHandoff(dir, 77, 50, 10), null, "an older first instance never answers");
    setTimeout(() => writeHandoff(dir, 77, { action: "busy", runs: 2, locale: "vi", at: 1 }), 30);
    assert.deepEqual(await waitHandoff(dir, 77, 2000, 10), { action: "busy", runs: 2, locale: "vi", at: 1 });
    assert.equal(await waitHandoff(dir, 77, 30, 10), null, "read once");
  });
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
