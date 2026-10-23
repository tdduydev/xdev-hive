import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configDirectory, newKey, WorkerIpc } from "@/worker/ipc.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(handler: (socket: Socket) => void): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".ipc-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path =
    process.platform === "win32" ? `\\\\.\\pipe\\xdev-hive-test-${process.pid}-${Date.now()}` : join(dir, "h.sock");
  const sockets = new Set<Socket>();
  const srv: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(path, resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        srv.close(() => resolve());
      }),
  );
  return path;
}

it("bắt tay trước mỗi op, đọc NDJSON bị chia khúc, status và session.list", async () => {
  const ops: string[] = [];
  const path = await server((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const req = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        ops.push(req.op);
        if (req.op === "hello") {
          expect(req.v).toBe(1);
          socket.write('{"ok":tr');
          setImmediate(() => socket.write('ue,"v":1}\n'));
        } else if (req.op === "worker.status")
          socket.write(
            `${JSON.stringify({ ok: true, state: "online", hubConnected: true, registered: true, machineId: "m", version: "0.2.16", runs: 2, owner: "desktop" })}\n`,
          );
        else socket.write('{"ok":true,"sessions":[]}\n');
        end = buffer.indexOf("\n");
      }
    });
  });
  const ipc = new WorkerIpc(async () => path);
  expect((await ipc.status()).owner).toBe("desktop");
  expect((await ipc.sessions()).sessions).toEqual([]);
  expect(ops).toEqual(["hello", "worker.status", "hello", "session.list"]);
});

it.each(["version", "oversize", "malformed", "closed", "timeout"])("đóng kết nối khi %s", async (mode) => {
  const path = await server((socket) =>
    socket.once("data", () => {
      if (mode === "version") socket.write('{"ok":true,"v":2}\n');
      if (mode === "oversize") socket.write("x".repeat(65537));
      if (mode === "malformed") socket.write("oops\n");
      if (mode === "closed") socket.end();
    }),
  );
  await expect(new WorkerIpc(async () => path, 100).status()).rejects.toThrow();
});

it("đường dẫn cấu hình theo Go trên ba hệ điều hành", () => {
  expect(configDirectory("linux", "/home/test", { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg");
  expect(configDirectory("darwin", "/home/test", {})).toBe(join("/home/test", "Library", "Application Support"));
  expect(configDirectory("win32", "/home/test", { APPDATA: "/roaming" })).toBe("/roaming");
});

function outboxServer(reply: (req: Record<string, unknown>) => Record<string, unknown>) {
  const reqs: Record<string, unknown>[] = [];
  const path = server((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const req = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (req.op === "hello") socket.write('{"ok":true,"v":1}\n');
        else {
          if (typeof req.bodyFile === "string") req.bodyFileContent = readFileSync(req.bodyFile, "utf8");
          reqs.push(req);
          socket.write(`${JSON.stringify(reply(req))}\n`);
        }
        end = buffer.indexOf("\n");
      }
    });
  });
  return { path, reqs };
}

it("submit nộp lần ghi cho hộp thư đi với khoá ULID và trả trạng thái queued", async () => {
  const { path, reqs } = outboxServer((req) => ({ ok: true, state: "queued", key: req.key, pending: 1, hub: "down" }));
  const reply = await new WorkerIpc(async () => await path).submit({
    source: "vscode",
    transport: "mcp",
    kind: "doc_comment",
    target: { type: "doc", id: "kien-truc" },
    body: { name: "doc_comment", arguments: { key: "kien-truc", body: "ok" } },
  });
  expect(reply.state).toBe("queued");
  expect(reqs[0]).toMatchObject({ op: "outbox.submit", source: "vscode", waitMs: 10000, target: { id: "kien-truc" } });
  expect(reqs[0]?.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(reply.key).toBe(reqs[0]?.key);
});

it("submit đưa thân lớn qua file incoming rồi xoá file", async () => {
  const home = await mkdtemp(join(process.cwd(), ".home-test-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  cleanups.push(async () => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  });
  const { path, reqs } = outboxServer((req) => ({ ok: true, state: "queued", key: req.key, pending: 1, hub: "down" }));
  const content = "nội dung dài ".repeat(8000);
  await new WorkerIpc(async () => await path).submit({
    source: "vscode",
    transport: "rpc",
    kind: "memory.write",
    body: { path: "memory/write", input: { content } },
  });
  const file = reqs[0]?.bodyFile as string;
  expect(reqs[0]?.body).toBeUndefined();
  expect(file.startsWith(join(home, ".xdev-hive", "outbox", "incoming"))).toBe(true);
  expect(JSON.parse(reqs[0]?.bodyFileContent as string).input.content).toBe(content);
  expect(existsSync(file)).toBe(false);
});

it("submit ném IpcError với mã của worker", async () => {
  const { path } = outboxServer(() => ({ ok: false, code: "NOT_SIGNED_IN", error: "Máy chưa đăng nhập hub." }));
  await expect(
    new WorkerIpc(async () => await path).submit({ source: "vscode", transport: "mcp", kind: "task_update", body: {} }),
  ).rejects.toMatchObject({ code: "NOT_SIGNED_IN" });
});

it("newKey theo thứ tự thời gian", () => {
  expect(newKey(1).localeCompare(newKey(2))).toBeLessThan(0);
  expect(newKey(0).slice(0, 10)).toBe("0000000000");
});
