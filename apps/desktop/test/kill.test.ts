import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { killTree } from "#desktop/main/runner/kill.ts";

/** A stand-in for a child process: only what killTree reads, with the signals sent to it. */
function fakeChild(pid: number | undefined) {
  const signals: string[] = [];
  const child = { pid, kill: (signal: string) => (signals.push(signal), true) } as unknown as ChildProcess;
  return { child, signals };
}

describe("stopping an agent CLI", () => {
  it("does nothing for a child that never started", () => {
    const { child, signals } = fakeChild(undefined);
    const spawned: string[] = [];
    killTree(child, { platform: "win32", spawn: (command) => spawned.push(command) });
    killTree(child);
    assert.deepEqual(signals, []);
    assert.deepEqual(spawned, []);
  });

  it("on Windows, has taskkill end the whole tree", () => {
    const { child, signals } = fakeChild(4242);
    const calls: { command: string; args: string[]; options: { windowsHide: boolean } }[] = [];
    killTree(child, { platform: "win32", spawn: (command, args, options) => calls.push({ command, args, options }) });
    assert.deepEqual(calls, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"], options: { windowsHide: true } }]);
    assert.deepEqual(signals, [], "no POSIX signals on Windows");
  });

  it("signals the child itself when its process group is already gone", { skip: process.platform === "win32" }, () => {
    // No process group has this id (far above any pid an OS hands out), so the group signal throws.
    const { child, signals } = fakeChild(2 ** 30);
    assert.doesNotThrow(() => killTree(child, { platform: "linux" }));
    assert.deepEqual(signals, ["SIGTERM"]);
  });

  it("stops a detached child and what it started, through its process group", { skip: process.platform === "win32" }, async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    const exited = once(child, "exit");
    killTree(child);
    const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
  });
});
