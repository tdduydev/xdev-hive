import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiskLister, MAX_DISKS, markWorktree, parseCimDisks, parseDf } from "#desktop/main/runner/disks.ts";
import { machineStats, type StatsSource } from "#desktop/main/machine-stats.ts";
import { SystemSampler } from "#desktop/main/runner/system.ts";
import { schemas } from "@xdev-hive/core";

const GB = 1024 ** 3;
const kb = (gb: number) => String(gb * 1024 * 1024);

describe("disk listing (79o)", () => {
  it("reads df -kP on Linux and leaves out memory, container, snap and boot mounts", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      `udev               ${kb(8)}         0   ${kb(8)}       0% /dev`,
      `tmpfs              ${kb(2)}      2048   ${kb(2)}       1% /run`,
      `/dev/nvme0n1p2   ${kb(500)}  ${kb(450)}   ${kb(50)}      90% /`,
      `/dev/nvme0n1p1          524288      6144     518144       2% /boot/efi`,
      `/dev/loop3           65536     65536          0     100% /snap/core20/2318`,
      `overlay          ${kb(500)}  ${kb(450)}   ${kb(50)}      90% /var/lib/docker/overlay2/abc/merged`,
      `/dev/sdb1        ${kb(2000)}  ${kb(500)}  ${kb(1500)}      25% /mnt/data disk`,
      `/dev/nvme0n1p2   ${kb(500)}  ${kb(450)}   ${kb(50)}      90% /home/bind`,
      "",
    ].join("\n");
    const disks = parseDf(out);
    assert.deepEqual(disks.map((d) => d.mount), ["/", "/mnt/data disk"]);
    assert.equal(disks[0]!.totalBytes, 500 * GB);
    assert.equal(disks[0]!.freeBytes, 50 * GB);
    assert.equal(disks[0]!.percent, 90);
    assert.equal(disks[1]!.percent, 25);
  });

  it("folds the APFS volumes of one macOS container into one disk and keeps external volumes", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity  Mounted on",
      `/dev/disk3s1s1  ${kb(460)}  ${kb(10)}  ${kb(200)}     5%    /`,
      `devfs                  234       234          0   100%    /dev`,
      `/dev/disk3s6    ${kb(460)}  ${kb(2)}   ${kb(200)}     1%    /System/Volumes/VM`,
      `/dev/disk3s5    ${kb(460)}  ${kb(250)} ${kb(200)}    56%    /System/Volumes/Data`,
      "map auto_home            0         0          0   100%    /System/Volumes/Data/home",
      `/dev/disk5s1    ${kb(1000)} ${kb(100)} ${kb(900)}    10%    /Volumes/Backup`,
    ].join("\n");
    const disks = parseDf(out);
    assert.deepEqual(disks.map((d) => d.mount), ["/", "/Volumes/Backup"]);
    // Used is the container's (total − shared free), not the system volume's own 10 GB.
    assert.equal(disks[0]!.percent, Math.round((460 - 200) / 460 * 100));
  });

  it("reads Win32_LogicalDisk JSON whether PowerShell printed one object or an array", () => {
    const one = parseCimDisks(JSON.stringify({ DeviceID: "C:", VolumeName: "Windows", Size: 512 * GB, FreeSpace: 64 * GB }));
    assert.deepEqual(one, [{ mount: "C:", label: "Windows", totalBytes: 512 * GB, freeBytes: 64 * GB, percent: 88 }]);
    const many = parseCimDisks(JSON.stringify([
      { DeviceID: "D:", VolumeName: "", Size: 2000 * GB, FreeSpace: 100 * GB },
      { DeviceID: "C:", VolumeName: "OS", Size: 512 * GB, FreeSpace: 300 * GB },
      { DeviceID: "E:", VolumeName: null, Size: null, FreeSpace: null },
    ]));
    assert.deepEqual(many.map((d) => [d.mount, d.label, d.percent]), [["C:", "OS", 41], ["D:", undefined, 95]]);
    assert.deepEqual(parseCimDisks(""), []);
    assert.deepEqual(parseCimDisks("not json"), []);
  });

  it("keeps at most 16 disks", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ DeviceID: `${String.fromCharCode(65 + (i % 26))}${i}:`, Size: 10 * GB, FreeSpace: GB }));
    assert.equal(parseCimDisks(JSON.stringify(rows)).length, MAX_DISKS);
  });

  it("tags the disk whose mount holds the worktree root", () => {
    const posix = [{ mount: "/", totalBytes: 1, freeBytes: 1, percent: 0 }, { mount: "/home", totalBytes: 1, freeBytes: 1, percent: 0 }, { mount: "/homex", totalBytes: 1, freeBytes: 1, percent: 0 }];
    assert.deepEqual(markWorktree(posix, "/home/me/.xdev-hive/worktrees", false).map((d) => d.worktree ?? false), [false, true, false]);
    assert.deepEqual(markWorktree(posix, "/srv/wt", false).map((d) => d.worktree ?? false), [true, false, false]);
    const win = [{ mount: "C:", totalBytes: 1, freeBytes: 1, percent: 0 }, { mount: "D:", totalBytes: 1, freeBytes: 1, percent: 0 }];
    assert.deepEqual(markWorktree(win, "d:\\work\\worktrees", true).map((d) => d.worktree ?? false), [false, true]);
  });

  it("shares one listing between callers and keeps a failed one as none", async () => {
    let calls = 0;
    const lister = new DiskLister(60_000, async () => { calls++; return [{ mount: "/", totalBytes: GB, freeBytes: GB, percent: 0 }]; });
    const [a, b] = await Promise.all([lister.get(), lister.get()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    await lister.get();
    assert.equal(calls, 1, "a fresh listing is reused within its age");
    const failing = new DiskLister(0, async () => { throw new Error("timeout"); });
    assert.equal(await failing.get(), null);
  });

  it("sends disks in the heartbeat, which this hub accepts and an older hub drops without failing", async () => {
    const lister = new DiskLister(60_000, async () => [{ mount: "/", totalBytes: 100 * GB, freeBytes: 5 * GB, percent: 95 }]);
    const s = await new SystemSampler(lister).sample(process.platform === "win32" ? "C:\\x" : "/tmp/x");
    if (process.platform !== "win32") assert.equal(s.disks![0]!.worktree, true);
    assert.ok(s.disk, "the single worktree disk stays for older hubs and the low-disk cleanup");
    const parsed = schemas["machines.heartbeat"].parse({ machine: "test", instance: "aaaaaaaa", system: s });
    assert.equal(parsed.system!.disks!.length, 1);
    const bad = schemas["machines.heartbeat"].parse({ machine: "test", instance: "aaaaaaaa", system: { ...s, disks: [{ mount: "" }] } });
    assert.equal(bad.system!.disks, undefined, "a list the hub cannot read is dropped, the beat still goes through");
  });

  it("lists every disk on Máy này with the worktree one tagged", async () => {
    const source: StatsSource = {
      cpus: () => [], loadavg: () => [0], totalmem: () => 1, freemem: () => 1, uptime: () => 1, hostname: () => "h",
      statfs: async () => ({ bsize: 1, blocks: 10, bavail: 5 }),
      disks: async () => [{ mount: "/", totalBytes: GB, freeBytes: GB, percent: 0 }, { mount: "/data", totalBytes: GB, freeBytes: 0, percent: 100 }],
    };
    const stats = await machineStats("/cfg", source, "/data/worktrees");
    if (process.platform !== "win32") assert.deepEqual(stats.disks!.map((d) => d.worktree ?? false), [false, true]);
    assert.equal(stats.diskTotal, 10);
    const none = await machineStats("/cfg", { ...source, disks: async () => null });
    assert.equal(none.disks, undefined);
  });
});
