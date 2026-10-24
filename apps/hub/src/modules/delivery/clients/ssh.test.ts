import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import ssh2 from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type FakeSsh, startFakeSsh } from "../testing/fake-ssh.ts";
import {
  connectSsh,
  generateServerKey,
  installCommand,
  probeHostKeys,
  SshError,
  type SshTarget,
  withSsh,
} from "./ssh.ts";

const key = generateServerKey();
const otherKey = generateServerKey();

let server: FakeSsh;
let authorized: string[] = [key.publicKey];

const target = (over: Partial<SshTarget> = {}): SshTarget => ({
  host: server.host,
  port: server.port,
  user: "deploy",
  privateKey: key.privateKey,
  hostKeys: server.hostKeys,
  ...over,
});

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    if (e instanceof SshError) return { kind: e.kind, hostKey: e.hostKey };
    throw e;
  }
  throw new Error("không lỗi");
};

beforeAll(async () => {
  server = await startFakeSsh({
    authorizedKeys: () => authorized,
    exec: (command) => {
      if (command === "echo hi") return { stdout: "xin chào\n", stderr: "cảnh báo\n", code: 3 };
      if (command === "sleep") return { hang: true };
      if (command === "big") return { stdout: Buffer.alloc(4096, 97) };
      return { stdout: "" };
    },
  });
});

afterAll(() => server.close());

afterEach(() => {
  authorized = [key.publicKey];
  server.commands.length = 0;
  server.logins = 0;
});

describe("khoá của hub", () => {
  it("sinh cặp ed25519 dạng OpenSSH và lệnh cài vào authorized_keys", () => {
    expect(key.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ xdev-hive$/);
    const cmd = installCommand(key.publicKey);
    expect(cmd).toContain("mkdir -p ~/.ssh");
    expect(cmd).toContain("chmod 700 ~/.ssh");
    expect(cmd).toContain(`echo '${key.publicKey}' >> ~/.ssh/authorized_keys`);
    expect(cmd).toContain("chmod 600 ~/.ssh/authorized_keys");
    expect(cmd).not.toContain("PRIVATE");
  });

  it("khoá sinh ra luôn đọc được: ssh2 làm hỏng khoảng 1/256 cặp ed25519", () => {
    const bad = Array.from({ length: 1000 }, () => generateServerKey().privateKey).filter(
      (k) => ssh2.utils.parseKey(k) instanceof Error,
    );
    expect(bad).toEqual([]);
  });
});

describe("host key", () => {
  it("lần đầu (chưa có host key): trả dấu vân tay, không xác thực, không chạy lệnh", async () => {
    expect(await failure(() => connectSsh(target({ hostKeys: [] })))).toEqual({
      kind: "hostkey_unconfirmed",
      hostKey: server.hostKeys[0],
    });
    expect(server.logins).toBe(0);
    expect(server.commands).toEqual([]);
  });

  it("host key đổi: dừng trước mọi lệnh, báo dấu vân tay vừa thấy", async () => {
    const stale = { algorithm: "ssh-ed25519", fingerprint: `SHA256:${"A".repeat(43)}` };
    expect(await failure(() => withSsh(target({ hostKeys: [stale] }), (c) => c.exec("echo hi")))).toEqual({
      kind: "hostkey_changed",
      hostKey: server.hostKeys[0],
    });
    expect(server.logins).toBe(0);
    expect(server.commands).toEqual([]);
  });

  it("máy chủ không còn thuật toán host key đã lưu: coi như host key đổi", async () => {
    const ecdsaOnly = { algorithm: "ecdsa-sha2-nistp256", fingerprint: `SHA256:${"B".repeat(43)}` };
    expect((await failure(() => connectSsh(target({ hostKeys: [ecdsaOnly] })))).kind).toBe("hostkey_changed");
    expect(server.commands).toEqual([]);
  });

  it("máy có nhiều host key: ép thuật toán đã lưu, dò được từng khoá", async () => {
    const multi = await startFakeSsh({
      hostKeys: [generateServerKey().privateKey, ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 }).private],
      authorizedKeys: () => [key.publicKey],
      exec: () => ({ stdout: "ok" }),
    });
    try {
      const [ed, ec] = multi.hostKeys as [FakeSsh["hostKeys"][0], FakeSsh["hostKeys"][0]];
      expect(ec.algorithm).toBe("ecdsa-sha2-nistp256");
      // Chỉ lưu khoá ECDSA: không ép thì máy chủ thương lượng ed25519 và bị báo nhầm "host key đổi".
      const out = await withSsh(target({ port: multi.port, hostKeys: [ec] }), (c) => c.exec("x"));
      expect(out.stdout).toBe("ok");
      expect(await probeHostKeys({ host: multi.host, port: multi.port })).toEqual(expect.arrayContaining([ed, ec]));
      expect(multi.commands).toEqual(["x"]);
    } finally {
      await multi.close();
    }
  });
});

describe("lỗi kết nối", () => {
  it("máy chủ không nhận khoá: lỗi xác thực", async () => {
    authorized = [otherKey.publicKey];
    expect((await failure(() => connectSsh(target()))).kind).toBe("auth");
    expect(server.commands).toEqual([]);
  });

  it("cổng đóng: lỗi mạng", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect((await failure(() => connectSsh(target({ port })))).kind).toBe("network");
  });

  it("máy nhận TCP nhưng không nói SSH: hết giờ chờ là lỗi mạng, lỗi thứ hai không làm sập tiến trình", async () => {
    const sockets = new Set<Socket>();
    const silent: Server = createServer((s) => {
      sockets.add(s);
      s.on("error", () => {});
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as { port: number }).port;
    try {
      const started = Date.now();
      expect((await failure(() => connectSsh(target({ port }), { readyTimeoutMs: 300 }))).kind).toBe("network");
      expect(Date.now() - started).toBeLessThan(5000);
      // ssh2 còn phát "Connection lost before handshake" sau lỗi hết giờ; chờ để lỗi đó (nếu có) xảy ra trong test.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });
});

describe("chạy lệnh", () => {
  it("trả stdout, stderr, mã thoát; giải mã UTF-8 sau khi gom đủ byte", async () => {
    const out = await withSsh(target(), (c) => c.exec("echo hi"));
    expect(out).toEqual({ code: 3, signal: null, stdout: "xin chào\n", stderr: "cảnh báo\n" });
    expect(server.logins).toBe(1);
  });

  it("có hạn giờ", async () => {
    expect((await failure(() => withSsh(target(), (c) => c.exec("sleep", { timeoutMs: 200 })))).kind).toBe(
      "exec_timeout",
    );
  });

  it("có trần output", async () => {
    expect((await failure(() => withSsh(target(), (c) => c.exec("big", { maxOutputBytes: 1000 })))).kind).toBe(
      "output_limit",
    );
  });
});

describe("SFTP", () => {
  it("tạo thư mục từng cấp, ghi từ Buffer và ReadableStream kèm quyền, chmod", async () => {
    const payload = Buffer.alloc(200_000, 7);
    await withSsh(target(), async (c) => {
      await c.mkdir("/home/deploy/.hive-deploy/d1", { recursive: true });
      await c.mkdir("/home/deploy/.hive-deploy/d1", { recursive: true });
      await c.writeFile("/home/deploy/.hive-deploy/d1/run.sh", "echo ok\n", { mode: 0o700 });
      const web = Readable.toWeb(Readable.from([payload.subarray(0, 100_000), payload.subarray(100_000)]));
      await c.writeFile("/home/deploy/.hive-deploy/d1/src.tar.gz", web as ReadableStream<Uint8Array>);
      await c.writeFile("/home/deploy/.hive-deploy/d1/env", "SECRET=x\n", { mode: 0o644 });
      await c.chmod("/home/deploy/.hive-deploy/d1/env", 0o600);
    });
    expect([...server.dirs]).toEqual(
      expect.arrayContaining(["/home", "/home/deploy", "/home/deploy/.hive-deploy", "/home/deploy/.hive-deploy/d1"]),
    );
    const file = (p: string) => server.files.get(`/home/deploy/.hive-deploy/d1/${p}`);
    expect(file("run.sh")?.data.toString()).toBe("echo ok\n");
    expect((file("run.sh")?.mode ?? 0) & 0o777).toBe(0o700);
    expect(file("src.tar.gz")?.data.equals(payload)).toBe(true);
    expect((file("src.tar.gz")?.mode ?? 0) & 0o777).toBe(0o600);
    expect((file("env")?.mode ?? 0) & 0o777).toBe(0o600);
  });

  it("mất kết nối giữa lúc ghi: báo lỗi, không treo", async () => {
    const flaky = await startFakeSsh({ authorizedKeys: () => [key.publicKey], dropOnWrite: true });
    try {
      const err = await failure(() =>
        withSsh(target({ port: flaky.port, hostKeys: flaky.hostKeys }), (c) =>
          c.writeFile("/tmp/x", Buffer.alloc(100_000, 1)),
        ),
      );
      expect(["network", "sftp"]).toContain(err.kind);
    } finally {
      await flaky.close();
    }
  });
});
