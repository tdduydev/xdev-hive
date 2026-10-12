// Đăng ký máy qua HTTP rồi nối WSS thật: khởi hub trên cổng ngẫu nhiên, client `ws` đóng vai worker Go.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app.ts";
import { attachWorkerGateway, CLOSE, isConnected, sendToMachine } from "./modules/fleet/index.ts";
import { createPool } from "./modules/platform/index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const orgId = randomUUID();
const tag = randomUUID().slice(0, 8);
let teamId = "";
let server: Server;
let gateway: { close: () => Promise<void> };
let base = "";

beforeAll(async () => {
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'GW', 'u')", [
    orgId,
    `gw-${tag}`,
  ]);
  teamId = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgId])
  ).rows[0].id;
  const app = createApp({ config: { port: 0, version: "test", publicUrl: "http://hub.test" }, pool });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve()) as Server;
  });
  // Heartbeat 5 giây (mức thấp nhất hợp đồng cho phép); test tự gửi heartbeat, không chờ.
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quietLogger });
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end()]);
});

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Seed mã đăng ký thẳng bằng superuser: luồng tạo mã của admin đội đã có test riêng ở module fleet. */
async function registrationToken(expiresIn = "1 hour", kind: "worker" | "host" = "worker"): Promise<string> {
  const token = `hwr_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await admin.query(
    `insert into hive.registration_tokens (org_id, team_id, token_hash, expires_at, created_by, kind)
     values ($1, $2, $3, now() + $4::interval, 'u', $5)`,
    [orgId, teamId, hash, expiresIn, kind],
  );
  return token;
}

function postRegister(body: unknown) {
  return fetch(`http://${base}/api/v1/worker/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerMachine(name: string, kind: "worker" | "host" = "worker") {
  const res = await postRegister({
    registrationToken: await registrationToken("1 hour", kind),
    machineId: name,
    os: "darwin",
    version: "0.2.0",
    clis: ["claude"],
    capacity: 1,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; machineToken: string; machineId: string };
}

/** Client WSS nhỏ: gom gói nhận được vào hàng đợi để test chờ từng gói theo thứ tự. */
class Worker {
  readonly ws: WebSocket;
  private inbox: HubToWorker[] = [];
  private waiters: ((m: HubToWorker) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(token?: string) {
    this.ws = new WebSocket(`ws://${base}/ws/worker`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    this.ws.on("message", (data) => {
      const msg = hubToWorker.parse(JSON.parse(data.toString()));
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) =>
      this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }

  hello(machineId: string, extra: Record<string, unknown> = {}) {
    this.send({
      type: "hello",
      machineId,
      version: "0.2.0",
      protoRange: [1, 1],
      os: "linux",
      clis: ["codex"],
      capacity: 3,
      ...extra,
    });
  }

  next(): Promise<HubToWorker> {
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function machineRow(id: string) {
  return (await admin.query("select status, last_seen_at, os, clis, capacity from hive.machines where id = $1", [id]))
    .rows[0];
}

async function until(check: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("POST /api/v1/worker/register", () => {
  it("trả machine token một lần", async () => {
    const out = await registerMachine(`http-${tag}`);
    expect(out.machineToken).toMatch(/^hwm_/);
    expect(out.machineId).toBe(`http-${tag}`);
  });

  it("mã sai trả 401", async () => {
    const res = await postRegister({ registrationToken: "hwr_sai", machineId: `x-${tag}`, os: "linux", version: "1" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/Mã đăng ký không hợp lệ/);
  });

  it("mã hết hạn trả 401", async () => {
    const res = await postRegister({
      registrationToken: await registrationToken("-1 minute"),
      machineId: `y-${tag}`,
      os: "linux",
      version: "1",
    });
    expect(res.status).toBe(401);
  });

  it("dùng lại mã trả 401", async () => {
    const token = await registrationToken();
    const body = { registrationToken: token, machineId: `z-${tag}`, os: "linux", version: "1" };
    expect((await postRegister(body)).status).toBe(200);
    expect((await postRegister(body)).status).toBe(401);
  });

  it("machineId sai dạng trả 400", async () => {
    const res = await postRegister({ registrationToken: "hwr_x", machineId: "Có Dấu", os: "linux", version: "1" });
    expect(res.status).toBe(400);
  });
});

describe("WSS /ws/worker", () => {
  it("từ chối khi thiếu hoặc sai machine token (401, không nâng cấp)", async () => {
    for (const token of [undefined, "hwm_sai"]) {
      const w = new Worker(token);
      const status = await new Promise<number | undefined>((resolve) => {
        w.ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
        w.ws.on("open", () => resolve(undefined));
        w.ws.on("error", () => {});
      });
      expect(status).toBe(401);
    }
  });

  it("hello → welcome, cập nhật máy online; heartbeat → heartbeat_ack; đóng → offline", async () => {
    const m = await registerMachine(`ws-${tag}`);
    const w = new Worker(m.machineToken);
    await w.opened();
    w.hello(m.machineId);
    const welcome = await w.next();
    expect(welcome).toMatchObject({ type: "welcome", v: 1, heartbeatSec: 5 });
    expect(welcome.type === "welcome" && welcome.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await machineRow(m.id)).toMatchObject({ status: "online", os: "linux", clis: ["codex"], capacity: 3 });
    expect(isConnected(m.id)).toBe(true);

    const seenBefore = (await machineRow(m.id)).last_seen_at as Date;
    await new Promise((r) => setTimeout(r, 10));
    w.send({ type: "heartbeat", load: 0, runs: [] });
    expect(await w.next()).toMatchObject({ type: "heartbeat_ack", renewed: [], cancel: [] });
    expect(((await machineRow(m.id)).last_seen_at as Date).getTime()).toBeGreaterThan(seenBefore.getTime());

    expect(sendToMachine(m.id, { type: "drain" })).toBe(true);
    expect(await w.next()).toMatchObject({ type: "drain", v: 1 });
    expect(sendToMachine(m.id, { type: "update", version: "0.3.0" })).toBe(true);
    expect(await w.next()).toMatchObject({ type: "update", v: 1, version: "0.3.0" });

    w.ws.close();
    await w.closed;
    await until(async () => (await machineRow(m.id)).status === "offline");
    expect(isConnected(m.id)).toBe(false);
    expect(sendToMachine(m.id, { type: "drain" })).toBe(false);
  });

  it("đóng kết nối khi machineId trong hello không khớp token", async () => {
    const m = await registerMachine(`lech-${tag}`);
    const w = new Worker(m.machineToken);
    await w.opened();
    w.hello(`may-khac-${tag}`);
    expect((await w.closed).code).toBe(CLOSE.machineMismatch);
  });

  it("đóng kết nối khi protoRange không chứa phiên bản của hub", async () => {
    const m = await registerMachine(`cu-${tag}`);
    const w = new Worker(m.machineToken);
    await w.opened();
    w.hello(m.machineId, { protoRange: [2, 3] });
    expect((await w.closed).code).toBe(CLOSE.protocolUnsupported);
  });

  it("đóng kết nối khi gói đầu tiên không phải hello hoặc không hợp lệ", async () => {
    const m = await registerMachine(`goi-${tag}`);
    const a = new Worker(m.machineToken);
    await a.opened();
    a.send({ type: "heartbeat", load: 0 });
    expect((await a.closed).code).toBe(CLOSE.badMessage);
    const b = new Worker(m.machineToken);
    await b.opened();
    b.ws.send("không phải json");
    expect((await b.closed).code).toBe(CLOSE.badMessage);
  });

  it("đóng kết nối khi không gửi hello đúng hạn", async () => {
    const m = await registerMachine(`im-${tag}`);
    const w = new Worker(m.machineToken);
    await w.opened();
    expect((await w.closed).code).toBe(CLOSE.timeout);
  });

  it("máy nối lại thì kết nối cũ bị đóng, máy vẫn online", async () => {
    const m = await registerMachine(`lai-${tag}`);
    const a = new Worker(m.machineToken);
    await a.opened();
    a.hello(m.machineId);
    await a.next();
    const b = new Worker(m.machineToken);
    await b.opened();
    b.hello(m.machineId);
    await b.next();
    expect((await a.closed).code).toBe(4409);
    await new Promise((r) => setTimeout(r, 50));
    expect((await machineRow(m.id)).status).toBe("online");
    b.ws.close();
    await b.closed;
  });

  it("máy bị thu hồi giữa phiên thì heartbeat kế tiếp đóng kết nối", async () => {
    const m = await registerMachine(`thu-${tag}`);
    const w = new Worker(m.machineToken);
    await w.opened();
    w.hello(m.machineId);
    await w.next();
    await admin.query("update hive.machines set status = 'revoked', revoked_at = now() where id = $1", [m.id]);
    w.send({ type: "heartbeat", load: 0 });
    expect((await w.closed).code).toBe(CLOSE.revoked);
    expect((await machineRow(m.id)).status).toBe("revoked");
  });
});

it("accepts only the runner mode authorized by the registration token", async () => {
  const dev = await registerMachine(`dev-mode-${tag}`);
  const fakeHost = new Worker(dev.machineToken);
  await fakeHost.opened();
  fakeHost.hello(dev.machineId, { runnerMode: "host" });
  expect((await fakeHost.closed).code).toBe(CLOSE.machineMismatch);
  expect((await machineRow(dev.id)).status).toBe("offline");
  const host = await registerMachine(`host-mode-${tag}`, "host");
  const wrongMode = new Worker(host.machineToken);
  await wrongMode.opened();
  wrongMode.hello(host.machineId);
  expect((await wrongMode.closed).code).toBe(CLOSE.machineMismatch);
  const correct = new Worker(host.machineToken);
  await correct.opened();
  correct.hello(host.machineId, { runnerMode: "host", cpuCount: 8, memoryMB: 16384 });
  expect((await correct.next()).type).toBe("welcome");
  expect((await machineRow(host.id)).status).toBe("online");
  correct.ws.close();
  await correct.closed;
});
