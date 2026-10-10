// What "Máy này" shows about the machine itself: load, memory and the disk the app's data lives on. The os and fs
// calls come in as arguments so a test can feed numbers instead of this machine's.
import { statfs } from "node:fs/promises";
import os from "node:os";
import type { MachineDisk, MachineStats } from "@xdev-hive/core";
import { diskLister, markWorktree } from "#desktop/main/runner/disks.ts";

export interface StatsSource {
  cpus(): Array<{ model: string }>;
  loadavg(): number[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  hostname(): string;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bavail: number }>;
  /** Every fixed disk (spec 79o); absent in a test that only feeds statfs. */
  disks?(): Promise<MachineDisk[] | null>;
}

/** The disk query fails on a path that is gone or a platform without statfs: the card then says "—", not an error. */
export async function machineStats(path: string, source: StatsSource = { ...os, statfs, disks: () => diskLister.get() }, worktreeRoot?: string): Promise<MachineStats> {
  const cpus = source.cpus();
  const [disk, disks] = await Promise.all([source.statfs(path).catch(() => null), source.disks?.().catch(() => null) ?? null]);
  // loadavg is always 0 on Windows: no figure there rather than a flat 0 %.
  const load = process.platform === "win32" || cpus.length === 0 ? null : source.loadavg()[0]! / cpus.length;
  return {
    hostname: source.hostname(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model?.trim() || null,
    load,
    memTotal: source.totalmem(),
    memFree: source.freemem(),
    diskPath: path,
    diskTotal: disk ? disk.bsize * disk.blocks : null,
    diskFree: disk ? disk.bsize * disk.bavail : null,
    ...(disks?.length ? { disks: worktreeRoot ? markWorktree(disks, worktreeRoot) : disks } : {}),
    uptime: source.uptime(),
  };
}
