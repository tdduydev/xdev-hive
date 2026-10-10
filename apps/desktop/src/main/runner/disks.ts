// Every fixed disk of the machine (spec 79o). The parsers are pure so a test can feed them another OS's output.
import path from "node:path";
import { execFile } from "node:child_process";
import type { MachineDisk } from "@xdev-hive/core";

export const MAX_DISKS = 16;
/** Smaller than this and it is a boot or firmware partition, not a place anyone keeps work. */
const TINY = 1024 ** 3;
/** df's first column for in-memory and container file systems, which are not disks. */
const PSEUDO = new Set(["tmpfs", "devtmpfs", "udev", "overlay", "shm", "none", "devfs", "proc", "sysfs", "squashfs", "efivarfs", "cgroup", "cgroup2", "run", "fusectl", "nsfs", "ramfs"]);
const SKIP_MOUNT = /^\/(?:proc|sys|dev|run|snap|var\/lib\/docker|var\/snap)(?:\/|$)|^\/boot(?:\/efi)?$|^\/System\/Volumes\/(?!Data$)|^\/private\/var\/vm$/;

const pct = (total: number, free: number) => Math.round(Math.max(0, Math.min(100, (total - free) / total * 100)));

function disk(mount: string, totalBytes: number, freeBytes: number, label?: string): MachineDisk {
  const free = Math.max(0, Math.min(totalBytes, freeBytes));
  return { mount: mount.slice(0, 300), ...(label ? { label: label.slice(0, 200) } : {}), totalBytes, freeBytes: free, percent: pct(totalBytes, free) };
}

/**
 * APFS volumes of one container (/dev/disk3s1s1, /dev/disk3s5) share its space, so they are one disk; elsewhere the
 * device itself is the key, which also folds bind mounts of the same partition.
 */
const deviceKey = (device: string) => device.replace(/^(\/dev\/disk\d+)s\d+(?:s\d+)?$/, "$1");

/** `df -kP`: one line per mount after the header; the mount point is the rest of the line, as it may hold spaces. */
export function parseDf(stdout: string): MachineDisk[] {
  const seen = new Map<string, MachineDisk>();
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const m = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/);
    if (!m) continue;
    const [, device, blocks, , avail, , mount] = m as unknown as [string, string, string, string, string, string, string];
    const totalBytes = Number(blocks) * 1024;
    if (PSEUDO.has(device) || device.startsWith("/dev/loop") || device.startsWith("map ") || SKIP_MOUNT.test(mount) || totalBytes < TINY) continue;
    const key = deviceKey(device);
    const prev = seen.get(key);
    // The shortest mount of a device stands for it: "/" rather than a bind mount or an APFS sibling.
    if (!prev || mount.length < prev.mount.length) seen.set(key, disk(mount, totalBytes, Number(avail) * 1024));
  }
  return [...seen.values()].sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, MAX_DISKS);
}

/** `ConvertTo-Json` of Win32_LogicalDisk: a bare object for one disk, an array for more; Size is null for an empty reader. */
export function parseCimDisks(stdout: string): MachineDisk[] {
  let rows: unknown;
  try { rows = JSON.parse(stdout); } catch { return []; }
  const list = (Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : []) as Array<Record<string, unknown>>;
  return list.flatMap((r) => {
    const total = Number(r.Size);
    const free = Number(r.FreeSpace);
    const mount = typeof r.DeviceID === "string" ? r.DeviceID.trim() : "";
    if (!mount || !Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return [];
    return [disk(mount, total, free, typeof r.VolumeName === "string" ? r.VolumeName.trim() : undefined)];
  }).sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, MAX_DISKS);
}

/** The disk whose mount is the longest prefix of the path; drive letters compare without case. */
export function markWorktree(disks: MachineDisk[], root: string, win = process.platform === "win32"): MachineDisk[] {
  const norm = (p: string) => (win ? p.replace(/\//g, "\\").toLowerCase() : p);
  const sep = win ? "\\" : "/";
  const target = norm(win ? path.win32.resolve(root) : path.posix.resolve(root));
  let best = -1;
  disks.forEach((d, i) => {
    const mount = norm(d.mount);
    const prefix = mount.endsWith(sep) ? mount : mount + sep;
    if ((target === mount || target.startsWith(prefix)) && (best < 0 || mount.length > norm(disks[best]!.mount).length)) best = i;
  });
  return disks.map((d, i) => {
    const { worktree: _, ...rest } = d;
    return i === best ? { ...rest, worktree: true } : rest;
  });
}

const run = (file: string, args: string[], timeout: number) => new Promise<string | null>((resolve) => {
  execFile(file, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
});

const CIM = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress";

/** null when the listing failed or timed out (a hung network mount, a slow PowerShell): the caller shows the one disk it measured. */
export async function listDisks(platform = process.platform, timeout = 8000): Promise<MachineDisk[] | null> {
  const out = platform === "win32"
    ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CIM], timeout)
    : await run("df", ["-kP"], timeout);
  if (out === null) return null;
  const disks = platform === "win32" ? parseCimDisks(out) : parseDf(out);
  return disks.length ? disks : null;
}

/**
 * One listing shared by the heartbeat sampler and the "Máy này" page, and at most one in flight: PowerShell takes a
 * second to start, so the page polling every 15 s and the 30 s sampler must not each spawn their own.
 */
export class DiskLister {
  #at = 0;
  #last: MachineDisk[] | null = null;
  #pending: Promise<MachineDisk[] | null> | null = null;
  readonly #maxAgeMs: number;
  readonly #list: () => Promise<MachineDisk[] | null>;
  constructor(maxAgeMs = 25_000, list: () => Promise<MachineDisk[] | null> = () => listDisks()) {
    this.#maxAgeMs = maxAgeMs;
    this.#list = list;
  }

  get(now = Date.now()): Promise<MachineDisk[] | null> {
    if (this.#at && now - this.#at < this.#maxAgeMs) return Promise.resolve(this.#last);
    this.#pending ??= this.#list()
      .catch(() => null)
      .then((d) => { this.#last = d; this.#at = Date.now(); return d; })
      .finally(() => { this.#pending = null; });
    return this.#pending;
  }
}

export const diskLister = new DiskLister();
