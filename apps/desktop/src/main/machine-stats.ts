// What "Máy này" shows about the machine itself: load, memory and the disk the app's data lives on. The os and fs
// calls come in as arguments so a test can feed numbers instead of this machine's.
import { statfs } from "node:fs/promises";
import os from "node:os";
import type { MachineStats } from "@xdev-hive/core";

export interface StatsSource {
  cpus(): Array<{ model: string }>;
  loadavg(): number[];
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  hostname(): string;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bavail: number }>;
}

/** The disk query fails on a path that is gone or a platform without statfs: the card then says "—", not an error. */
export async function machineStats(path: string, source: StatsSource = { ...os, statfs }): Promise<MachineStats> {
  const cpus = source.cpus();
  const disk = await source.statfs(path).catch(() => null);
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
    uptime: source.uptime(),
  };
}
