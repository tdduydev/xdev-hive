import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

  async call<T>(
    op: "worker.status" | "session.list" | "outbox.submit",
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const path = await this.path();
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let buffer = Buffer.alloc(0);
      let hello = true;
      const timer = setTimeout(() => finish(new Error("Worker không trả lời đúng hạn")), timeoutMs);
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
              socket.write(`${JSON.stringify({ ...params, op })}\n`);
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

  /**
   * Nộp một lần ghi cho hộp thư đi của worker (specs/027 contracts/outbox-ipc.md): hub vắng thì worker giữ và gửi lại
   * cùng khoá, nên extension không ghi thẳng hub và không tự thử lại. Worker không chạy thì lỗi kết nối được ném ra để
   * người gọi báo, không gọi hub thay.
   */
  async submit(request: OutboxSubmit): Promise<OutboxReply> {
    const waitMs = request.waitMs ?? 10_000;
    const params: Record<string, unknown> = { ...request, key: request.key ?? newKey(), waitMs };
    if (Buffer.byteLength(JSON.stringify(params)) > submitLineBudget) {
      // Thân lớn hơn một dòng IPC: đi qua file trong incoming, worker đọc rồi xoá.
      const file = await writeIncoming(params.body);
      delete params.body;
      params.bodyFile = file;
      try {
        return await this.call<OutboxReply>("outbox.submit", params, waitMs + this.timeoutMs);
      } finally {
        await rm(file, { force: true });
      }
    }
    return this.call<OutboxReply>("outbox.submit", params, waitMs + this.timeoutMs);
  }
}

export type OutboxSubmit = {
  key?: string;
  source: string;
  transport: "mcp" | "rpc";
  kind: string;
  target?: { type: string; id: string };
  project?: string;
  body: unknown;
  waitMs?: number;
};

export type OutboxResult = {
  outcome: "accepted" | "duplicate" | "rejected";
  code?: string;
  reason?: string;
  receivedAt?: string;
  response?: unknown;
};

export type OutboxReply =
  | { state: "accepted" | "duplicate" | "rejected"; key: string; result: OutboxResult }
  | { state: "queued"; key: string; pending: number; hub: string }
  | { state: "held"; key: string; heldReason: string; reason?: string; pending: number; hub: string };

// Chừa chỗ cho phần còn lại của dòng dưới giới hạn 64 KiB của socket.
const submitLineBudget = 65536 - 4096;

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Khoá ULID như `outbox.NewKey` của worker, để tên file trong hộp thư xếp theo thứ tự tạo. */
export function newKey(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = crockford[t % 32] + time;
  let rand = "";
  for (const byte of randomBytes(16)) rand += crockford[byte % 32];
  return time + rand;
}

async function writeIncoming(body: unknown): Promise<string> {
  const dir = join(homedir(), ".xdev-hive", "outbox", "incoming");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${randomBytes(12).toString("hex")}.json`);
  await writeFile(file, JSON.stringify(body), { mode: 0o600 });
  return file;
}
