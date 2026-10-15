import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exec } from "@/lib/exec.ts";

export function configDirectory(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}

export async function socketPath(): Promise<string> {
  const override = process.env.HIVE_SOCKET;
  if (process.platform !== "win32") return override ?? join(configDirectory(), "xdev-hive", "run", "hive.sock");
  const prefix = "\\\\.\\pipe\\";
  if (override)
    return override.toLowerCase().startsWith(prefix)
      ? override
      : `${prefix}xdev-hive-${createHash("sha256").update(resolve(override).toLowerCase()).digest("hex").slice(0, 16)}`;
  const result = await exec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  const sid = result.stdout.trim();
  if (result.code !== 0 || !/^S-\d+(?:-\d+)+$/.test(sid)) throw new Error("Không đọc được SID của người dùng Windows");
  return `${prefix}xdev-hive-${sid}`;
}

export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type WorkerStatus = {
  state: string;
  hubConnected: boolean;
  registered: boolean;
  machineId: string;
  version: string;
  runs: number;
  owner: "desktop" | "vscode" | "cli";
};

export class WorkerIpc {
  private readonly path: () => Promise<string>;
  private readonly timeoutMs: number;
  constructor(path: () => Promise<string> = socketPath, timeoutMs = 3000) {
    this.path = path;
    this.timeoutMs = timeoutMs;
  }

  async call<T>(op: "worker.status" | "session.list"): Promise<T> {
    const path = await this.path();
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let buffer = Buffer.alloc(0);
      let hello = true;
      const timer = setTimeout(() => finish(new Error("Worker không trả lời đúng hạn")), this.timeoutMs);
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new Error("Worker đóng kết nối trước khi trả lời")));
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ op: "hello", v: 1, client: "xdev-hive-vscode" })}\n`),
      );
      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
        for (;;) {
          const end = buffer.indexOf(10);
          if (end > 65535 || (end < 0 && buffer.length > 65535)) return finish(new Error("Dòng IPC quá lớn"));
          if (end < 0) return;
          const line = buffer.subarray(0, end).toString();
          buffer = buffer.subarray(end + 1);
          try {
            const reply = JSON.parse(line);
            if (reply.ok !== true)
              return finish(
                new IpcError(
                  String(reply.code),
                  typeof reply.error === "string" ? reply.error : "Worker từ chối yêu cầu",
                ),
              );
            if (hello) {
              if (reply.v !== 1) return finish(new IpcError("version", "Phiên bản giao thức worker không tương thích"));
              hello = false;
              socket.write(`${JSON.stringify({ op })}\n`);
            } else {
              finish(undefined, reply);
              return;
            }
          } catch {
            return finish(new Error("Trả lời IPC không phải JSON hợp lệ"));
          }
        }
      });
    });
  }

  async status(): Promise<WorkerStatus> {
    const status = await this.call<WorkerStatus>("worker.status");
    if (
      typeof status.state !== "string" ||
      typeof status.registered !== "boolean" ||
      typeof status.hubConnected !== "boolean" ||
      typeof status.machineId !== "string" ||
      typeof status.version !== "string" ||
      !Number.isSafeInteger(status.runs) ||
      !["desktop", "vscode", "cli"].includes(status.owner)
    )
      throw new Error("Trạng thái worker không hợp lệ");
    return status;
  }

  sessions(): Promise<{ sessions: unknown[] }> {
    return this.call("session.list");
  }
}
