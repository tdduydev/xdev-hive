// Gói agent của máy dùng chung (specs/011 T060, T063): nhãn, tóm tắt gói từ heartbeat, bật/tắt và đăng nhập gói từ web
// qua WSS thật. Client `ws` đóng vai worker Go; hàm của module gọi thẳng thay cho route (route chỉ thêm phiên đăng nhập).
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AccountLogin } from "@xdev-hive/contracts";
import {
  type HubToWorker,
  hubToWorker,
  PROTOCOL_VERSION,
  type WorkerAccountSummary,
} from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app.ts";
import {
  cancelAccountLogin,
  getAccountLogin,
  inputAccountLogin,
  listMachineAccounts,
  resetAccountLogins,
  setMachineAccount,
  startAccountLogin,
} from "./modules/fleet/accounts.ts";
import { attachWorkerGateway } from "./modules/fleet/index.ts";
import { listMachines, setMachineLabels } from "./modules/fleet/machines.ts";
import { createRegistration, registerMachine } from "./modules/fleet/registration.ts";
import { listSdlcFleet, quotaResetsAt } from "./modules/fleet/sdlc-fleet.ts";
import { createPool, type Tx, withTenant } from "./modules/platform/index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const orgId = randomUUID();
const tag = randomUUID().slice(0, 8);
const user = (name: string) => `${name}-${tag}`;
let teamId = "";
let server: Server;
let gateway: { close: () => Promise<void> };
let base = "";

beforeAll(async () => {
  await admin.query(
    `insert into auth."user" (id, name, email) select id, id, id || '@seed.test' from unnest($1::text[]) as id
     on conflict (id) do nothing`,
    [[user("admin"), user("member"), user("owner")]],
  );
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'ACC', $3)", [
    orgId,
    `acc-${tag}`,
    user("admin"),
  ]);
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')",
    [orgId, user("admin"), user("member"), user("owner")],
  );
  teamId = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgId])
  ).rows[0].id;
  await admin.query(
    `insert into hive.team_members (team_id, org_id, user_id, role) values
       ($1, $2, $3, 'admin'), ($1, $2, $4, 'member'), ($1, $2, $5, 'member')`,
    [teamId, orgId, user("admin"), user("member"), user("owner")],
  );
  const app = createApp({ config: { port: 0, version: "test", publicUrl: "http://hub.test" }, pool });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve()) as Server;
  });
  gateway = attachWorkerGateway(server, { pool, heartbeatSec: 5, helloTimeoutMs: 500, logger: quietLogger });
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => resetAccountLogins());

afterAll(async () => {
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([admin.end(), pool.end()]);
});

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const asUser = <T>(name: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(pool, { userId: user(name), orgId }, (tx) => fn(tx, user(name)));

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** Đăng ký máy bằng mã của quản trị đội (mã mang nhãn và cờ dùng chung khi có). */
async function newMachine(
  name: string,
  flags: { labels?: string[]; shared?: boolean; labelsOnly?: boolean } = {},
  by = "admin",
) {
  const { token } = await asUser(by === "owner" ? "admin" : by, (tx, userId) =>
    createRegistration(tx, userId, teamId, "worker", flags),
  );
  // Máy cá nhân của một thành viên: mã do quản trị đội tạo nhưng ghi người tạo là chủ máy.
  if (by === "owner")
    await admin.query("update hive.registration_tokens set created_by = $1 where org_id = $2 and used_at is null", [
      user("owner"),
      orgId,
    ]);
  return registerMachine(pool, {
    registrationToken: token,
    machineId: `${name}-${tag}`,
    os: "linux",
    version: "0.9.0",
    clis: ["claude", "codex"],
    capacity: 2,
  });
}

class Worker {
  readonly ws: WebSocket;
  private inbox: HubToWorker[] = [];
  private waiters: ((m: HubToWorker) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(token: string) {
    this.ws = new WebSocket(`ws://${base}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", (data) => {
      const msg = hubToWorker.parse(JSON.parse(data.toString()));
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code) => resolve(code)));
  }

  static async connect(token: string, machineId: string, capabilities = ["accounts-remote"]) {
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
      os: "linux",
      clis: ["claude", "codex"],
      capacity: 2,
      capabilities,
    });
    const welcome = await w.next();
    if (welcome.type !== "welcome") throw new Error(`cần welcome, nhận ${welcome.type}`);
    return { w, welcome };
  }

  send(msg: Record<string, unknown>) {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: randomUUID(), ...msg }));
  }

  /** Gửi heartbeat và chờ hub ghi xong (heartbeat_ack). */
  async heartbeat(extra: Record<string, unknown> = {}) {
    this.send({ type: "heartbeat", load: 0, runs: [], ...extra });
    await this.until("heartbeat_ack");
  }

  next(): Promise<HubToWorker> {
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async until<T extends HubToWorker["type"]>(type: T): Promise<Extract<HubToWorker, { type: T }>> {
    for (;;) {
      const m = await this.next();
      if (m.type === type) return m as Extract<HubToWorker, { type: T }>;
    }
  }
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Hết thời gian chờ");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const summary: WorkerAccountSummary = {
  id: "claude-1",
  cli: "claude",
  label: "Gói Max",
  roles: [],
  enabled: true,
  loggedIn: true,
  sessionPct: 95,
  weekPct: 30,
  resetsAt: "2026-10-14T05:00:00.000Z",
  stopAtSession: 90,
  stopAtWeek: 0,
  inUse: 0,
};

const auditData = async (action: string) =>
  (
    await admin.query("select data, actor_user_id from hive.audit_log where org_id = $1 and action = $2", [
      orgId,
      action,
    ])
  ).rows as { data: Record<string, unknown>; actor_user_id: string | null }[];

describe("nhãn máy và mã đăng ký có nhãn (T060)", () => {
  it("máy đăng ký bằng mã có nhãn nhận sẵn nhãn, dùng chung và chỉ nhận run có nhãn", async () => {
    const m = await newMachine("lbl", { labels: ["sdlc", "sdlc", "linux"], shared: true, labelsOnly: true });
    const [row] = (await admin.query("select labels, shared, labels_only from hive.machines where id = $1", [m.id]))
      .rows;
    expect(row).toEqual({ labels: ["sdlc", "linux"], shared: true, labels_only: true });
  });

  it("nhãn sai định dạng bị từ chối; đổi nhãn có audit", async () => {
    expect(await codeOf(() => newMachine("bad", { labels: ["Có Dấu"] }))).toBeDefined();
    const m = await newMachine("set");
    const out = await asUser("admin", (tx, userId) =>
      setMachineLabels(tx, userId, m.id, { labels: ["sdlc"], labelsOnly: false }),
    );
    expect(out.labels).toEqual(["sdlc"]);
    expect((await auditData("machine.labels")).some((a) => a.data.name === m.machineId)).toBe(true);
    expect(
      await codeOf(() =>
        asUser("member", (tx, userId) => setMachineLabels(tx, userId, m.id, { labels: [], labelsOnly: false })),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
  });
});

describe("tóm tắt gói từ heartbeat (T060)", () => {
  it("welcome báo shared cho máy dùng chung; heartbeat lưu gói, bỏ trường lạ, thiếu accounts thì giữ", async () => {
    const m = await newMachine("hb", { shared: true, labels: ["sdlc"] });
    const { w, welcome } = await Worker.connect(m.machineToken, m.machineId);
    expect(welcome.features).toEqual(["shared"]);
    await w.heartbeat({ accounts: [{ ...summary, email: "a@b.vn", token: "sk-secret" }] });
    await w.heartbeat();
    const [row] = (await admin.query("select accounts, accounts_at from hive.machines where id = $1", [m.id])).rows;
    expect(row.accounts).toEqual([summary]);
    expect(row.accounts_at).not.toBeNull();
    expect(JSON.stringify(row.accounts)).not.toContain("sk-secret");

    const fleet = await asUser("admin", (tx, userId) => listSdlcFleet(tx, userId, teamId));
    const mine = fleet.find((f) => f.id === m.id);
    expect(mine?.canSetAccounts).toBe(true);
    expect(mine?.quotaResetsAt).toBe(summary.resetsAt);
    w.ws.close();
  });

  it("máy cá nhân: welcome không có shared, quản trị đội không thấy gói của chủ máy", async () => {
    const m = await newMachine("own", {}, "owner");
    const { w, welcome } = await Worker.connect(m.machineToken, m.machineId);
    expect(welcome.features).toEqual([]);
    await w.heartbeat({ accounts: [summary] });
    const list = await asUser("admin", (tx, userId) => listMachines(tx, userId, teamId));
    expect(list.find((x) => x.id === m.id)?.accounts).toBeNull();
    const view = await asUser("admin", (tx, userId) => listMachineAccounts(tx, userId, m.id));
    expect(view).toMatchObject({ accounts: null, remote: false, reason: "personal" });
    expect(
      await codeOf(() =>
        asUser("admin", (tx, userId) =>
          setMachineAccount(tx, userId, { machineId: m.id, accountId: "claude-1", enabled: false }),
        ),
      ),
    ).toBe("MACHINE_NOT_SHARED");
    w.ws.close();
  });

  it("worker cũ không có accounts-remote: không bật/tắt hay đăng nhập từ web", async () => {
    const m = await newMachine("old", { shared: true });
    const { w } = await Worker.connect(m.machineToken, m.machineId, []);
    const view = await asUser("admin", (tx, userId) => listMachineAccounts(tx, userId, m.id));
    expect(view).toMatchObject({ remote: false, reason: "old_worker" });
    expect(
      await codeOf(() =>
        startAccountLogin(
          pool,
          { userId: user("admin"), orgId },
          { machineId: m.id, cli: "claude", label: "A", how: "plan" },
        ),
      ),
    ).toBe("WORKER_TOO_OLD");
    w.ws.close();
  });

  it("bật/tắt gói: chỉ quản trị đội, ghi trước vào tóm tắt, có audit", async () => {
    const m = await newMachine("set-acc", { shared: true });
    const { w } = await Worker.connect(m.machineToken, m.machineId);
    await w.heartbeat({ accounts: [summary] });
    const input = { machineId: m.id, accountId: "claude-1", enabled: false };
    expect(await codeOf(() => asUser("member", (tx, userId) => setMachineAccount(tx, userId, input)))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    expect(
      await codeOf(() =>
        asUser("admin", (tx, userId) => setMachineAccount(tx, userId, { ...input, accountId: "khong-co" })),
      ),
    ).toBe("ACCOUNT_NOT_FOUND");
    const out = await asUser("admin", (tx, userId) => setMachineAccount(tx, userId, input));
    expect(out.accounts?.[0]?.enabled).toBe(false);
    expect((await auditData("machine.account_set")).map((a) => a.data.accountId)).toContain("claude-1");
    w.ws.close();
  });
});

describe("đăng nhập gói từ web (T063)", () => {
  const start = (
    machineId: string,
    extra: Partial<{ cli: "claude" | "codex"; how: "plan" | "device" | "token" }> = {},
  ) =>
    startAccountLogin(
      pool,
      { userId: user("admin"), orgId },
      { machineId, cli: "claude", label: "Gói đội", how: "plan", ...extra },
    );
  const get = (machineId: string, requestId: string) =>
    asUser("admin", (tx, userId) => getAccountLogin(tx, userId, { machineId, requestId }));

  it("Claude: URL và nhắc dán mã tới web, mã dán đi thẳng xuống worker và không nằm trong audit", async () => {
    const m = await newMachine("login", { shared: true });
    const { w } = await Worker.connect(m.machineToken, m.machineId);
    expect(
      await codeOf(() =>
        startAccountLogin(
          pool,
          { userId: user("member"), orgId },
          { machineId: m.id, cli: "claude", label: "A", how: "plan" },
        ),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");

    const login = await start(m.id);
    const cmd = await w.until("account_login_start");
    expect(cmd).toMatchObject({ requestId: login.requestId, cli: "claude", how: "plan", label: "Gói đội" });
    expect(await codeOf(() => start(m.id))).toBe("LOGIN_BUSY");

    // Máy chưa nhắc dán mã thì chưa nhận chữ.
    expect(
      await codeOf(() =>
        asUser("admin", (tx, userId) => inputAccountLogin(tx, userId, { machineId: m.id, requestId: login.requestId })),
      ),
    ).toBe("LOGIN_NOT_WAITING");

    const event = (kind: string, text: string, extra: Record<string, unknown> = {}) =>
      w.send({ type: "account_login_event", requestId: login.requestId, kind, text, ...extra });
    event("url", "javascript:alert(1)");
    event("url", "https://claude.ai/oauth/authorize?code=true&state=abc");
    event("prompt", "Dán mã xác nhận");
    let seen: AccountLogin | undefined;
    await until(async () => {
      seen = await get(m.id, login.requestId);
      return seen.needsInput;
    });
    expect(seen).toMatchObject({ status: "waiting", url: "https://claude.ai/oauth/authorize?code=true&state=abc" });

    const secret = `code-${randomUUID()}`;
    const { send } = await asUser("admin", (tx, userId) =>
      inputAccountLogin(tx, userId, { machineId: m.id, requestId: login.requestId }),
    );
    expect(send(secret).needsInput).toBe(false);
    expect(await w.until("account_login_input")).toMatchObject({ requestId: login.requestId, text: secret });

    event("done", "", { accountId: "claude-2" });
    await until(async () => (await get(m.id, login.requestId)).status === "done");
    const done = await get(m.id, login.requestId);
    expect(done).toMatchObject({ accountId: "claude-2", url: null, code: null });

    const audit = await admin.query("select action, data::text as data from hive.audit_log where target_id = $1", [
      m.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "machine.account_login.start",
        "machine.account_login.input",
        "machine.account_login.done",
      ]),
    );
    expect(audit.rows.some((r) => r.data.includes(secret))).toBe(false);
    // Phiên đã xong: máy nhận phiên mới.
    expect((await start(m.id, { how: "token" })).status).toBe("starting");
    w.ws.close();
  });

  it("Codex: mã thiết bị; huỷ gửi account_login_cancel xuống worker", async () => {
    const m = await newMachine("codex", { shared: true });
    const { w } = await Worker.connect(m.machineToken, m.machineId);
    const login = await start(m.id, { cli: "codex", how: "device" });
    await w.until("account_login_start");
    w.send({
      type: "account_login_event",
      requestId: login.requestId,
      kind: "url",
      text: "https://auth.openai.com/codex/device",
    });
    w.send({ type: "account_login_event", requestId: login.requestId, kind: "code", text: "ABCD-12345" });
    await until(async () => (await get(m.id, login.requestId)).code === "ABCD-12345");
    const { commit } = await asUser("admin", (tx, userId) =>
      cancelAccountLogin(tx, userId, { machineId: m.id, requestId: login.requestId }),
    );
    expect(commit().status).toBe("cancelled");
    expect(await w.until("account_login_cancel")).toMatchObject({ requestId: login.requestId });
    expect((await auditData("machine.account_login.cancel")).length).toBeGreaterThan(0);
    w.ws.close();
  });

  it("hết hạn thì huỷ ở worker; máy mất kết nối thì phiên báo lỗi", async () => {
    const m = await newMachine("expire", { shared: true });
    const { w } = await Worker.connect(m.machineToken, m.machineId);
    const login = await startAccountLogin(
      pool,
      { userId: user("admin"), orgId },
      { machineId: m.id, cli: "claude", label: "A", how: "plan" },
      { timeoutMs: 100 },
    );
    expect(await w.until("account_login_cancel")).toMatchObject({ requestId: login.requestId });
    expect((await get(m.id, login.requestId)).status).toBe("expired");

    const second = await start(m.id);
    await w.until("account_login_start");
    w.ws.close();
    await w.closed;
    await until(async () => (await get(m.id, second.requestId)).status === "error");
    const actors = (await auditData("machine.account_login.error")).map((a) => a.actor_user_id);
    expect(actors).toContain(null);
  });
});

describe("quotaResetsAt", () => {
  it("chỉ có giờ khi mọi gói dùng được đều chạm ngưỡng dừng", () => {
    expect(quotaResetsAt(null)).toBeNull();
    expect(quotaResetsAt([summary])).toBe(summary.resetsAt);
    expect(quotaResetsAt([summary, { ...summary, id: "claude-2", sessionPct: 10 }])).toBeNull();
    expect(quotaResetsAt([summary, { ...summary, id: "x", enabled: false, sessionPct: 10 }])).toBe(summary.resetsAt);
  });
});
