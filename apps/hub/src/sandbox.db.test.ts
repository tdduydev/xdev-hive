import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type EnvImage, type Run, SUGGESTED_EGRESS_RULES } from "@xdev-hive/contracts";
import { hubToWorker, PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import type { OutgoingMessage } from "./modules/fleet/index.ts";
import { createAuth } from "./modules/identity/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";
import { createTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const tag = randomUUID().slice(0, 8);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const secret = "test-secret-0123456789abcdef-0123456789";
let org: OrgFixture & { user: (n: string) => string };
let projectId: string;
let engine: RunsEngine;
let app: ReturnType<typeof createApp>;
let cookie: string;
let userId: string;
let workerId: string;
let hostId: string;
const messages: Array<{ machineId: string; msg: OutgoingMessage }> = [];
const image = { baseImage: "node:24", setupScriptHash: "a".repeat(64) };
const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(pool, { orgId: org.orgId, userId: org.user("owner") }, fn);

beforeAll(async () => {
  org = await seedOrg(admin, `sb-api-${tag}`);
  projectId = (
    await seedProject(admin, pool, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("owner"),
      masterKey,
      key: `sb-api-${tag}`,
      settings: { ...defaultProjectSettings(), features: { ...defaultProjectSettings().features, sandbox: true } },
    })
  ).projectId;
  const seedMachine = async (name: string, kind: string) =>
    // Máy dùng chung của đội: nhận cả run của đội (Leader, gate AI) lẫn run của mọi thành viên (ADR 0017).
    (
      await admin.query(
        "insert into hive.machines (org_id, team_id, name, kind, os, version, clis, status, last_seen_at, capacity, shared) values ($1, $2, $3, $4, 'linux', '1', '{claude}', 'online', now(), 8, true) returning id",
        [org.orgId, org.teamId, name, kind],
      )
    ).rows[0].id;
  workerId = await seedMachine(`dev-${tag}`, "worker");
  hostId = await seedMachine(`host-${tag}`, "host");
  engine = createRunsEngine({
    pool,
    publicUrl: "http://hub.test",
    authSecret: secret,
    providerFactory: () => createMemoryProvider("gitlab", ["xdev-team"]),
    send: (machineId, msg) => {
      messages.push({ machineId, msg });
      return true;
    },
    isConnected: () => true,
    logger: { warn: () => {}, error: () => {} },
  });
  const auth = createAuth({ pool: authPool, baseURL: "http://hub.test", secret, allowEmailSignUp: true });
  app = createApp({ config: { port: 0, version: "test", publicUrl: "http://hub.test" }, auth, pool, runs: engine });
  const signup = await app.request("http://hub.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Quản trị", email: `sb-${tag}@test.example`, password: "test-password-long-enough" }),
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  userId = ((await signup.json()) as { user: { id: string } }).user.id;
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'admin')", [
    org.orgId,
    userId,
  ]);
});
afterAll(async () => {
  engine?.stop();
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});
const api = async (method: string, path: string, body?: unknown, overrides: Record<string, string> = {}) => {
  const res = await app.request(`http://hub.test/api/v1/sandbox${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-hive-org": org.orgId, ...overrides },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};
async function newRun(machineId?: string): Promise<Run> {
  const task = await tenant((tx) =>
    createTask(tx, org.user("owner"), { projectId, title: "Chạy sandbox", body: "Mô tả" }),
  );
  const started = await tenant((tx) => engine.startRun(tx, org.user("owner"), { taskId: task.id, machineId }));
  return started.run;
}

describe("sandbox HTTP contract", () => {
  it("requires login and active membership regardless of organization header", async () => {
    expect((await api("GET", "/settings", undefined, { cookie: "" })).status).toBe(401);
    expect((await api("GET", "/settings", undefined, { "x-hive-org": randomUUID() })).status).toBe(403);
  });
  it("validates proxy rule and image syntax", async () => {
    expect((await api("POST", "/allowlist", { rule: "example.com:65536" })).status).toBe(400);
    expect((await api("POST", "/allowlist", { rule: "example.com\n127.0.0.1" })).status).toBe(400);
    expect(
      (await api("PUT", `/projects/${projectId}/image`, { baseImage: "node:24", setupScriptHash: "invalid" })).status,
    ).toBe(400);
  });
  it("lists, adds, removes rules and manages settings and project image", async () => {
    expect((await api("GET", "/settings")).data).toEqual({ locked: false, useSuggestedDefaults: false });
    const orgEntry = await api("POST", "/allowlist", { rule: "API.Internal.:00443", note: "API nội bộ" });
    expect(orgEntry.status).toBe(200);
    expect(orgEntry.data).toMatchObject({ rule: "api.internal:443", projectId: null, addedBy: userId });
    const entry = await api("POST", "/allowlist", { rule: "packages.internal:443", projectId });
    expect(entry.status).toBe(200);
    expect((await api("GET", `/allowlist?projectId=${projectId}`)).data).toHaveLength(1);
    expect((await api("PUT", "/settings", { locked: true, useSuggestedDefaults: true })).status).toBe(200);
    expect((await api("GET", `/projects/${projectId}/allowlist`)).data.rules).toEqual([
      ...SUGGESTED_EGRESS_RULES,
      "api.internal:443",
    ]);
    const denied = await api("POST", "/allowlist", { projectId, rule: "new.internal" });
    expect(denied.status).toBe(409);
    expect(denied.data.data.code).toBe("ALLOWLIST_LOCKED");
    expect((await api("DELETE", `/allowlist/${entry.data.id}`, { projectId })).status).toBe(200);
    expect((await api("PUT", `/projects/${projectId}/image`, image)).data).toMatchObject(image);
    expect((await api("GET", `/projects/${projectId}/image`)).data as EnvImage).toMatchObject(image);
    await api("PUT", "/settings", { locked: false, useSuggestedDefaults: false });
  });
  it("only organization admin changes organization policy", async () => {
    await admin.query("update hive.org_members set role = 'member' where org_id = $1 and user_id = $2", [
      org.orgId,
      userId,
    ]);
    try {
      expect((await api("PUT", "/settings", { locked: true, useSuggestedDefaults: true })).status).toBe(403);
      expect((await api("POST", "/allowlist", { rule: "new.internal" })).status).toBe(403);
    } finally {
      await admin.query("update hive.org_members set role = 'admin' where org_id = $1 and user_id = $2", [
        org.orgId,
        userId,
      ]);
    }
  });
});

describe("sandbox dispatch", () => {
  it("selects a host and sends effective allowlist and project environment image", async () => {
    await api("POST", "/allowlist", { projectId, rule: "packages.internal:443" });
    const run = await newRun();
    messages.length = 0;
    expect(await engine.dispatch(org.orgId, run.id)).toBe(true);
    const offer = messages.find((m) => m.msg.type === "job_offer");
    expect(offer?.machineId).toBe(hostId);
    expect(offer?.msg).toMatchObject({
      type: "job_offer",
      runId: run.id,
      attempt: 1,
      spec: {
        kind: "code",
        execution: "sandbox",
        sandbox: { allowlist: ["api.internal:443", "packages.internal:443"], image },
      },
    });
    expect(hubToWorker.safeParse({ ...offer?.msg, v: PROTOCOL_VERSION, id: "offer" }).success).toBe(true);
  });
  it("stays queued when only development workers are online", async () => {
    await admin.query("update hive.machines set status = 'offline' where id = $1", [hostId]);
    try {
      const run = await newRun();
      messages.length = 0;
      expect(await engine.dispatch(org.orgId, run.id)).toBe(false);
      expect(messages).toEqual([]);
      expect((await admin.query("select state from hive.runs where id = $1", [run.id])).rows[0].state).toBe("queued");
    } finally {
      await admin.query("update hive.machines set status = 'online' where id = $1", [hostId]);
    }
  });
  it("respects current organization lock when offering a queued run", async () => {
    const run = await newRun(hostId);
    await api("PUT", "/settings", { locked: true, useSuggestedDefaults: false });
    messages.length = 0;
    await engine.dispatch(org.orgId, run.id);
    const offer = messages.find((m) => m.msg.type === "job_offer");
    expect(offer?.msg).toMatchObject({ spec: { sandbox: { allowlist: ["api.internal:443"] } } });
    await api("PUT", "/settings", { locked: false, useSuggestedDefaults: false });
  });
  it("rejects pinning a sandbox run to a development worker", async () => {
    expect(await errorCode(() => newRun(workerId))).toBe("MACHINE_NOT_FOUND");
  });
  it("fails clearly before creating a run when environment image is missing", async () => {
    await admin.query("delete from hive.env_images where project_id = $1", [projectId]);
    try {
      expect(await errorCode(() => newRun())).toBe("SANDBOX_IMAGE_REQUIRED");
    } finally {
      await api("PUT", `/projects/${projectId}/image`, image);
    }
  });
  it("sends ordinary jobs only to development workers when sandbox is off", async () => {
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{features,sandbox}', 'false') where id = $1",
      [projectId],
    );
    try {
      expect(await errorCode(() => newRun(hostId))).toBe("MACHINE_NOT_FOUND");
      const run = await newRun(workerId);
      messages.length = 0;
      await engine.dispatch(org.orgId, run.id);
      const offer = messages.find((m) => m.msg.type === "job_offer");
      expect(offer?.machineId).toBe(workerId);
      expect(offer?.msg).toMatchObject({ spec: { execution: "worker" } });
      if (offer?.msg.type === "job_offer") expect(offer.msg.spec).not.toHaveProperty("sandbox");
    } finally {
      await admin.query(
        "update hive.projects set settings = jsonb_set(settings, '{features,sandbox}', 'true') where id = $1",
        [projectId],
      );
    }
  });
});
