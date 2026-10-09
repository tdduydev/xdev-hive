import os from "node:os";
import path from "node:path";
import { readFile, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { MachineSystem } from "@xdev-hive/core";

const percent = (used: number, total: number) => Math.round(Math.max(0, Math.min(100, used / total * 100)));
const text = (value: string, max: number) => value.trim().slice(0, max);
const command = (file: string, args: string[]) => new Promise<string>(resolve => {
  execFile(file, args, { timeout: 2000, maxBuffer: 4096, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : stdout.trim()));
});

/** ENOENT means the worktree root has not been created yet; its nearest parent is on the target volume. */
export async function volume(root: string): Promise<MachineSystem["disk"]> {
  try {
    const s = await statfs(root);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = Math.max(0, Math.min(totalBytes, s.bavail * s.bsize));
    return totalBytes > 0 ? { percent: percent(totalBytes - freeBytes, totalBytes), detail: "", freeBytes, totalBytes } : undefined;
  } catch (err) {
    const parent = path.dirname(root);
    return (err as NodeJS.ErrnoException).code === "ENOENT" && parent !== root ? volume(parent) : undefined;
  }
}

function cpuTimes() {
  const cpus = os.cpus();
  return { cpus, idle: cpus.reduce((n, c) => n + c.times.idle, 0), total: cpus.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0) };
}

export class SystemSampler {
  #previous = cpuTimes();
  #identity?: Promise<Pick<MachineSystem, "os" | "osName" | "hardware">>;
  #refreshing: Promise<MachineSystem | undefined> | null = null;
  /** The last finished sample; the heartbeat sends this instead of waiting on statfs or the OS commands. */
  latest: MachineSystem | undefined;

  /** One sample at a time: a slow disk or OS command makes the next timer tick share it rather than pile up. */
  refresh(root: string): Promise<MachineSystem | undefined> {
    this.#refreshing ??= this.sample(root)
      .then((s) => (this.latest = s), () => this.latest)
      .finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #identify(): Promise<Pick<MachineSystem, "os" | "osName" | "hardware">> {
    const platform = os.platform();
    let kind: MachineSystem["os"] = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
    let osName = `${os.type()} ${os.release()}`;
    let model = "";
    if (platform === "darwin") {
      const [version, hardware] = await Promise.all([command("/usr/bin/sw_vers", ["-productVersion"]), command("/usr/sbin/sysctl", ["-n", "hw.model"])]);
      osName = `macOS ${version || os.release()}`;
      model = hardware;
    } else if (platform === "linux") {
      const release = await readFile("/etc/os-release", "utf8").catch(() => "");
      const fields = Object.fromEntries(release.split("\n").flatMap(line => {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        return m ? [[m[1], m[2]!.replace(/^['"]|['"]$/g, "")]] : [];
      }));
      if (fields.ID === "ubuntu") kind = "ubuntu";
      osName = fields.PRETTY_NAME || osName;
      model = await readFile("/sys/devices/virtual/dmi/id/product_name", "utf8").catch(() => "");
    } else if (platform === "win32") {
      const [name, hardware] = await Promise.all([
        command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$s = Get-CimInstance Win32_OperatingSystem; $s.Caption + ' ' + $s.Version"]),
        command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).Model"]),
      ]);
      osName = name || osName;
      model = hardware;
    }
    return { os: kind, osName: text(osName, 200), hardware: text([model, os.cpus()[0]?.model, os.arch()].filter(Boolean).join(" · "), 300) };
  }

  async sample(root: string): Promise<MachineSystem> {
    this.#identity ??= this.#identify();
    const current = cpuTimes();
    const total = current.total - this.#previous.total;
    const idle = current.idle - this.#previous.idle;
    this.#previous = current;
    const totalBytes = os.totalmem();
    const usedBytes = Math.max(0, totalBytes - os.freemem());
    const load = os.loadavg()[0];
    return {
      ...await this.#identity,
      uptimeSeconds: Math.floor(os.uptime()),
      // The first beat can have no elapsed ticks: omit CPU rather than invent a utilization.
      ...(total > 0 && idle >= 0 && current.cpus.length ? { cpu: { percent: percent(total - idle, total), detail: "", cores: current.cpus.length, ...(os.platform() === "win32" ? {} : { load }) } } : {}),
      ...(totalBytes > 0 ? { ram: { percent: percent(usedBytes, totalBytes), detail: "", usedBytes, totalBytes } } : {}),
      disk: await volume(path.resolve(root)),
    };
  }
}
