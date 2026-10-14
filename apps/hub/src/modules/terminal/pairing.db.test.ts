// Ghép thiết bị, gỡ thiết bị, tắt khẩn cấp và trạng thái từ xa (specs/010 T021): worker giả qua /ws/worker trả lời
// `term_pair` và báo `term_state` như máy thật; hub chỉ chuyển gói, kiểm chủ máy và ghi audit.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { contract } from "@xdev-hive/contracts";
import { type HubToWorker, hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { attachWorkerGateway, createRegistration, registerMachine, registerTerminalHandlers } from "../fleet/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { disableRemote, listDevices, revokeDevice } from "./devices.ts";
import { createTerminalHandlers } from "./gateway.ts";
import { type PairCompleteInput, pairComplete, pairOptions, type RemoteDeps } from "./pairing.ts";
import { remoteMachines } from "./queries.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const closers: Array<() => Promise<void> | void> = [];
const deps: RemoteDeps = { enabled: true, publicUrl: "https://hive.example.vn", pairWaitMs: 1500 };

let org: OrgFixture & { user: (n: string) => string };
let host = "";
let macId = "";
let mac: Worker;
let offlineId = "";
let sharedId = "";

class Worker {
  readonly ws: WebSocket;
  readonly inbox: HubToWorker[] = [];
  constructor(token: string) {
    this.ws = new WebSocket(`ws://${host}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => this.inbox.push(hubToWorker.parse(JSON.parse(data.toString()))));
  }
  static async connect(token: string, machineId: string) {
    const w = new Worker(token);
    await new Promise<void>((resolve, reject) => {
      w.ws.once("open", () => resolve());
      w.ws.once("error", reject);
    });
    w.send({
      type: "hello",
      machineId,
      version: "0.9.0",
      protoRange: [1, 1],
      os: "darwin",
      clis: ["claude"],
      capacity: 1,
      capabilities: ["terminal"],
    });
    await w.until((m) => m.type === "welcome");
    closers.push(() => w.ws.close());
    return w;
  }
  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }
  async until<T extends HubToWorker>(match: (m: HubToWorker) => m is T, ms?: number): Promise<T>;
  async until(match: (m: HubToWorker) => boolean, ms?: number): Promise<HubToWorker>;
  async until(match: (m: HubToWorker) => boolean, ms = 4000): Promise<HubToWorker> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as HubToWorker;
      if (Date.now() > end) throw new Error("Hết thời gian chờ gói");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));

const userOf = (who: string) => ({ id: org.user(who), name: who, email: `${org.user(who)}@seed.test` });

async function newMachine(name: string, shared: boolean) {
  const { token } = await as("tmember", (tx, userId) =>
    createRegistration(tx, userId, org.teamId, "worker", shared ? { shared: true } : {}),
  );
  return registerMachine(pool, {
    registrationToken: token,
    machineId: `${name}-${tag}`,
    os: "darwin",
    version: "0.9.0",
    clis: ["claude"],
    capacity: 1,
  });
}

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const audits = async (action: string, targetId: string) =>
  (
    await admin.query<{ actor_user_id: string | null; data: Record<string, unknown> }>(
      "select actor_user_id, data from hive.audit_log where action = $1 and target_id = $2 order by created_at",
      [action, targetId],
    )
  ).rows;

const state = (extra: Record<string, unknown> = {}) => ({
  type: "term_state",
  enabled: true,
  totp: { enabled: false, locked: false },
  roots: [{ id: "root-01", label: "code" }],
  clis: ["claude", "codex"],
  accounts: [{ id: "a1", label: "Gói cá nhân", cli: "claude", state: "ready" }],
  devices: [],
  sessions: [],
  confirmOnMachine: true,
  ...extra,
});

const pairInput = (pairId: string): PairCompleteInput => ({
  machineId: macId,
  pairId,
  label: "iPhone của An",
  credentialId: Buffer.from("cred-1").toString("base64url"),
  spki: Buffer.from("spki").toString("base64url"),
  tag: Buffer.alloc(32, 7).toString("base64url"),
  synced: true,
});

beforeAll(async () => {
  org = await seedOrg(admin, `pair-${tag}`);
  // Thành viên đội đăng ký máy cá nhân của mình (quyền machines.register thường chỉ quản trị đội có).
  await admin.query("update hive.team_members set role = 'admin' where team_id = $1 and user_id = $2", [
    org.teamId,
    org.user("tmember"),
  ]);
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quiet });
  closers.push(registerTerminalHandlers(createTerminalHandlers(pool)));
  closers.push(
    () => gateway.close(),
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const m = await newMachine("mac", false);
  macId = m.id;
  mac = await Worker.connect(m.machineToken, `mac-${tag}`);
  offlineId = (await newMachine("off", false)).id;
  const shared = await newMachine("shared", true);
  sharedId = shared.id;
  await Worker.connect(shared.machineToken, `shared-${tag}`);
});

afterAll(async () => {
  for (const close of closers.reverse()) await close();
  await Promise.all([admin.end(), pool.end()]);
});

describe("term_state", () => {
  it("lưu bản sao cho `remote.machines`, audit bật và thư mục với nguồn là máy", async () => {
    mac.send(
      state({ totp: { enabled: true, locked: true, lockedUntil: new Date(Date.now() + 60_000).toISOString() } }),
    );
    await until(async () => (await audits("terminal.remote_enable", macId)).length === 1);
    const [machine] = await as("tmember", (tx, userId) => remoteMachines(tx, userId));
    expect(machine?.remote).toMatchObject({
      enabled: true,
      roots: [{ id: "root-01", label: "code" }],
      clis: ["claude", "codex"],
      accounts: [{ id: "a1", cli: "claude", state: "ready" }],
      totp: { enabled: true, locked: true },
      confirmOnMachine: true,
    });
    const [enable] = await audits("terminal.remote_enable", macId);
    expect(enable).toMatchObject({ actor_user_id: org.user("tmember"), data: { source: "machine" } });
    expect(await audits("terminal.root_add", macId)).toHaveLength(1);

    mac.send(state({ enabled: false, roots: [{ id: "root-02", label: "khac" }] }));
    await until(async () => (await audits("terminal.remote_disable", macId)).length === 1);
    expect((await audits("terminal.root_remove", macId)).map((a) => a.data.rootId)).toEqual(["root-01"]);
    expect((await audits("terminal.root_add", macId)).map((a) => a.data.rootId)).toEqual(["root-01", "root-02"]);
    const [after] = await as("tmember", (tx, userId) => remoteMachines(tx, userId));
    expect(after?.remote).toMatchObject({ enabled: false, totp: { enabled: false, locked: false } });
  });

  it("máy dùng chung báo trạng thái thì hub bỏ qua", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const { rowCount } = await admin.query("select 1 from hive.machine_remote_state where machine_id = $1", [sharedId]);
    expect(rowCount).toBe(0);
  });

  it("phiên máy không còn giữ thì kết thúc; phiên còn giữ thì không đụng", async () => {
    const kept = randomUUID();
    const lost = randomUUID();
    for (const sessionId of [kept, lost]) {
      mac.send({
        type: "term_opened",
        sessionId,
        accountLabel: "Gói",
        permissions: "workspace",
        origin: "local",
        cli: "claude",
        cols: 80,
        rows: 24,
        record: true,
      });
    }
    await until(
      async () =>
        (await admin.query("select 1 from hive.terminal_sessions where id = any($1)", [[kept, lost]])).rowCount === 2,
    );
    mac.send(state({ sessions: [{ id: kept, origin: "local", controller: "local" }] }));
    await until(
      async () =>
        (await admin.query("select 1 from hive.terminal_sessions where id = $1 and state = 'failed'", [lost]))
          .rowCount === 1,
    );
    const { rows } = await admin.query("select state from hive.terminal_sessions where id = $1", [kept]);
    expect(rows[0].state).toBe("running");
  });
});

describe("ghép thiết bị", () => {
  it("pairOptions: chỉ chủ máy cá nhân online, khi hub bật cờ; rp là host của hub", async () => {
    const input = { machineId: macId, pairId: "pair-opt" };
    const options = await as("tmember", (tx) => pairOptions(tx, userOf("tmember"), input, deps));
    expect(options).toMatchObject({
      userId: org.user("tmember"),
      publicKey: { rp: { id: "hive.example.vn" }, authenticatorSelection: { userVerification: "required" } },
    });
    const off = { ...deps, enabled: false };
    expect(await errorCode(() => as("tmember", (tx) => pairOptions(tx, userOf("tmember"), input, off)))).toBe(
      "REMOTE_DISABLED_HUB",
    );
    expect(await errorCode(() => as("tadmin", (tx) => pairOptions(tx, userOf("tadmin"), input, deps)))).toBe(
      "MACHINE_NOT_YOURS",
    );
    const shared = { machineId: sharedId, pairId: "pair-zz" };
    expect(await errorCode(() => as("tmember", (tx) => pairOptions(tx, userOf("tmember"), shared, deps)))).toBe(
      "MACHINE_SHARED",
    );
    const offline = { machineId: offlineId, pairId: "pair-zz" };
    expect(await errorCode(() => as("tmember", (tx) => pairOptions(tx, userOf("tmember"), offline, deps)))).toBe(
      "MACHINE_OFFLINE",
    );
  });

  it("pairComplete chuyển term_pair; máy cho phép thì có thiết bị và audit", async () => {
    const done = pairComplete(pool, org.orgId, userOf("tmember"), pairInput("pair-ok"), deps);
    const pair = await mac.until((m) => m.type === "term_pair");
    expect(pair).toMatchObject({ pairId: "pair-ok", userId: org.user("tmember"), label: "iPhone của An" });
    mac.send({ type: "term_pair_result", pairId: "pair-ok", ok: true, deviceId: "dev-001" });
    expect(await done).toMatchObject({
      id: "dev-001",
      label: "iPhone của An",
      userId: org.user("tmember"),
      synced: true,
    });
    const devices = await as("tmember", (tx, userId) => listDevices(tx, userId, macId));
    expect(devices.map((d) => d.id)).toEqual(["dev-001"]);
    const [audit] = await audits("terminal.pair", macId);
    expect(audit).toMatchObject({ actor_user_id: org.user("tmember"), data: { deviceId: "dev-001" } });
  });

  it("máy từ chối, tag sai, hết giờ: lỗi riêng và audit pair_denied; người khác không ghép được", async () => {
    const denied = pairComplete(pool, org.orgId, userOf("tmember"), pairInput("pair-no"), deps);
    await mac.until((m) => m.type === "term_pair");
    mac.send({ type: "term_pair_result", pairId: "pair-no", ok: false, reason: "denied" });
    expect(await errorCode(() => denied)).toBe("PAIR_DENIED");

    const bad = pairComplete(pool, org.orgId, userOf("tmember"), pairInput("pair-bad"), deps);
    await mac.until((m) => m.type === "term_pair");
    mac.send({ type: "term_pair_result", pairId: "pair-bad", ok: false, reason: "bad_tag" });
    expect(await errorCode(() => bad)).toBe("PAIR_BAD_TAG");

    const silent = pairComplete(pool, org.orgId, userOf("tmember"), pairInput("pair-late"), deps);
    await mac.until((m) => m.type === "term_pair");
    expect(await errorCode(() => silent)).toBe("PAIR_TIMEOUT");
    expect((await audits("terminal.pair_denied", macId)).map((a) => a.data.reason)).toEqual([
      "denied",
      "bad_tag",
      "timeout",
    ]);

    expect(await errorCode(() => pairComplete(pool, org.orgId, userOf("tadmin"), pairInput("pair-x1"), deps))).toBe(
      "MACHINE_NOT_YOURS",
    );
    expect(mac.inbox.some((m) => m.type === "term_pair")).toBe(false);
  });

  it("hub không có route bật từ xa hay thêm thiết bị", () => {
    expect(Object.keys(contract.remote).filter((k) => /enable|addDevice|roots/i.test(k))).toEqual([]);
  });
});

describe("gỡ thiết bị và tắt khẩn cấp", () => {
  it("chủ máy gỡ: máy nhận term_device_revoke, thiết bị biến khỏi danh sách; thiết bị lạ, máy offline báo lỗi", async () => {
    expect(await errorCode(() => as("tadmin", (tx, userId) => revokeDevice(tx, userId, macId, "dev-001")))).toBe(
      "MACHINE_NOT_YOURS",
    );
    await as("tmember", (tx, userId) => revokeDevice(tx, userId, macId, "dev-001"));
    expect(await mac.until((m) => m.type === "term_device_revoke")).toMatchObject({
      deviceId: "dev-001",
      by: org.user("tmember"),
    });
    expect(await as("tmember", (tx, userId) => listDevices(tx, userId, macId))).toEqual([]);
    expect(await audits("terminal.device_revoke", macId)).toHaveLength(1);
    expect(await errorCode(() => as("tmember", (tx, userId) => revokeDevice(tx, userId, macId, "dev-zzz")))).toBe(
      "DEVICE_NOT_FOUND",
    );
    expect(await errorCode(() => as("tmember", (tx, userId) => revokeDevice(tx, userId, offlineId, "dev-001")))).toBe(
      "MACHINE_OFFLINE",
    );
  });

  it("thiết bị máy báo mà hub chưa biết thì thêm; máy thôi báo thì gạch và audit nguồn máy", async () => {
    const d2 = { id: "dev-002", label: "Pixel", userId: org.user("tmember"), synced: false };
    mac.send(state({ devices: [d2] }));
    await until(async () => (await as("tmember", (tx, userId) => listDevices(tx, userId, macId))).length === 1);
    mac.send(state({ devices: [] }));
    await until(async () => (await as("tmember", (tx, userId) => listDevices(tx, userId, macId))).length === 0);
    const revokes = await audits("terminal.device_revoke", macId);
    expect(revokes.at(-1)?.data).toMatchObject({ source: "machine", deviceId: "dev-002" });
  });

  it("chủ máy hoặc quản trị đội tắt được; thành viên khác và quản trị đội khác thì không", async () => {
    mac.send(state({ enabled: true }));
    await until(
      async () => (await as("tmember", (tx, userId) => remoteMachines(tx, userId)))[0]?.remote?.enabled === true,
    );
    expect(await errorCode(() => as("tviewer", (tx, userId) => disableRemote(tx, userId, macId)))).toBe(
      "MACHINE_NOT_YOURS",
    );
    expect(await errorCode(() => as("oadmin", (tx, userId) => disableRemote(tx, userId, macId)))).toBe(
      "MACHINE_NOT_YOURS",
    );
    const view = await as("tadmin", (tx, userId) => disableRemote(tx, userId, macId));
    expect(view.remote?.enabled).toBe(false);
    expect(await mac.until((m) => m.type === "term_disable")).toMatchObject({ by: org.user("tadmin") });
    const [audit] = (await audits("terminal.remote_disable", macId)).filter((a) => a.data.source === "hub");
    expect(audit).toMatchObject({ actor_user_id: org.user("tadmin"), data: { ownerUserId: org.user("tmember") } });
    expect(await errorCode(() => as("tmember", (tx, userId) => disableRemote(tx, userId, offlineId)))).toBe(
      "MACHINE_OFFLINE",
    );
  });
});
