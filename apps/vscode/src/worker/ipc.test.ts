import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configDirectory, WorkerIpc } from "@/worker/ipc.ts";

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
