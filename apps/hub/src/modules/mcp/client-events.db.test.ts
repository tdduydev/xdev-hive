import { randomBytes, randomUUID } from "node:crypto";
import { MCP_CLIENT_EVENT_META, MCP_IDEMPOTENCY_META } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { clientMachineOf } from "../fleet/index.ts";
import { type Auth, createAuth } from "../identity/index.ts";
import { ConflictError, createPool } from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { createMcpEndpoint } from "./endpoint.ts";
import type { McpPrincipal } from "./principal.ts";
import { McpToolRegistry } from "./registry.ts";

/*
 * T009 (specs/027 US1): tool có ghi qua cổng MCP thật với khoá chống trùng. Tool giả ghi một dòng audit riêng để đếm số
 * lần handler thật sự chạy; máy client khai chỉ được giữ khi là máy của người gọi.
 */

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let endpoint: (request: Request) => Promise<Response>;
let auth: Auth;
let machineId = "";
const registry = new McpToolRegistry();
const principals = new Map<string, McpPrincipal>();
const runs = { count: 0, reject: false };
let after = 0;

const newKey = () => randomBytes(16).toString("hex");

async function call(
  token: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
  meta?: Record<string, unknown>,
) {
  const res = await endpoint(
    new Request("https://hive.example.com/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      }),
    }),
  );
  const raw = await res.text();
  const data =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? (raw
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5) ?? "{}")
      : raw;
  const body = JSON.parse(data) as {
    result?: { isError?: boolean; content: { text: string }[]; _meta?: Record<string, unknown> };
  };
  return {
    isError: body.result?.isError ?? false,
    text: body.result?.content.map((c) => c.text).join("\n") ?? "",
    event: body.result?._meta?.[MCP_CLIENT_EVENT_META] as { outcome: string; code?: string } | undefined,
  };
}

const eventRow = async (key: string) =>
  (
    await admin.query(
      "select outcome, source, machine_id, target_type, target_id, reason_code from hive.client_events where org_id = $1 and idempotency_key = $2",
      [org.orgId, key],
    )
  ).rows[0];

beforeAll(async () => {
  org = await seedOrg(admin, `mcpce-${tag}`);
  machineId = (
    await admin.query(
      "insert into hive.machines (org_id, team_id, name, os, version, registered_by) values ($1, $2, 'mac-mini', 'macos', '1', $3) returning id",
      [org.orgId, org.teamId, org.user("tmember")],
    )
  ).rows[0].id as string;
  registry.provideAuthorization(requireOrgRole);
  registry.provideClientMachine(clientMachineOf);
  registry.register({
    name: "task_update",
    description: "Ghi tiến độ",
    input: z.object({ note: z.string() }),
    runKinds: ["code"],
    writes: true,
    handler: async (args, { afterCommit }) => {
      runs.count += 1;
      if (runs.reject) throw new ConflictError("RUN_NOT_ACTIVE", "Run không còn chạy.");
      afterCommit?.(() => {
        after += 1;
      });
      return { saved: args.note, n: runs.count };
    },
  });
  auth = createAuth({
    pool: authPool,
    baseURL: "https://hive.example.com",
    secret: "test-secret-0123456789abcdef-0123456789",
  });
  endpoint = createMcpEndpoint({
    auth,
    pool,
    registry,
    version: "test",
    runTokens: { verify: async (token) => principals.get(token) ?? null },
  });
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

function runToken(): { token: string; taskId: string } {
  const token = `run-${randomUUID()}`;
  const taskId = randomUUID();
  principals.set(token, {
    kind: "run",
    userId: org.user("tmember"),
    orgId: org.orgId,
    runId: randomUUID(),
    runKind: "code",
    taskId,
    scopes: [],
  });
  return { token, taskId };
}

describe("tool có ghi với khoá chống trùng", () => {
  it("gửi lại cùng khoá nhận kết quả đã lưu, handler chạy một lần", async () => {
    const { token, taskId } = runToken();
    const key = newKey();
    const before = runs.count;
    const first = await call(token, "task_update", { note: "xong bước 1" }, { "Idempotency-Key": key });
    const again = await call(token, "task_update", { note: "xong bước 1" }, { "Idempotency-Key": key });
    expect(first.isError).toBe(false);
    expect(first.event?.outcome).toBe("accepted");
    expect(again.event?.outcome).toBe("duplicate");
    expect(again.text).toBe(first.text);
    expect(runs.count - before).toBe(1);
    expect(await eventRow(key)).toMatchObject({
      outcome: "accepted",
      source: "worker-run",
      target_type: "task",
      target_id: taskId,
    });
  });

  it("khoá trong _meta dùng được khi client không đặt header", async () => {
    const { token } = runToken();
    const key = newKey();
    const first = await call(token, "task_update", { note: "a" }, {}, { [MCP_IDEMPOTENCY_META]: key });
    const again = await call(token, "task_update", { note: "a" }, {}, { [MCP_IDEMPOTENCY_META]: key });
    expect([first.event?.outcome, again.event?.outcome]).toEqual(["accepted", "duplicate"]);
  });

  it("hai lần gửi cùng lúc chỉ chạy handler một lần", async () => {
    const { token } = runToken();
    const key = newKey();
    const before = runs.count;
    const results = await Promise.all(
      [1, 2, 3].map(() => call(token, "task_update", { note: "song song" }, { "Idempotency-Key": key })),
    );
    expect(runs.count - before).toBe(1);
    expect(results.map((r) => r.event?.outcome).sort()).toEqual(["accepted", "duplicate", "duplicate"]);
  });

  it("lần bị từ chối rollback phần đã ghi, gửi lại nhận đúng lần từ chối đó", async () => {
    const { token } = runToken();
    const key = newKey();
    const afterBefore = after;
    runs.reject = true;
    try {
      const first = await call(token, "task_update", { note: "muộn" }, { "Idempotency-Key": key });
      expect(first.isError).toBe(true);
      expect(first.event).toMatchObject({ outcome: "rejected", code: "RUN_NOT_ACTIVE" });
    } finally {
      runs.reject = false;
    }
    const again = await call(token, "task_update", { note: "muộn" }, { "Idempotency-Key": key });
    expect(again.isError).toBe(true);
    expect(again.event).toMatchObject({ outcome: "duplicate", code: "RUN_NOT_ACTIVE" });
    expect(after).toBe(afterBefore);
    expect(await eventRow(key)).toMatchObject({ outcome: "rejected", reason_code: "RUN_NOT_ACTIVE" });
  });

  it("giữ máy của người gọi, bỏ máy lạ", async () => {
    const { token } = runToken();
    const own = newKey();
    const stranger = newKey();
    await call(
      token,
      "task_update",
      { note: "m" },
      { "Idempotency-Key": own, "X-Hive-Machine": machineId, "X-Hive-Source": "mcp-local" },
    );
    await call(token, "task_update", { note: "m" }, { "Idempotency-Key": stranger, "X-Hive-Machine": randomUUID() });
    expect(await eventRow(own)).toMatchObject({ machine_id: machineId, source: "mcp-local" });
    expect(await eventRow(stranger)).toMatchObject({ machine_id: null });
  });

  it("khoá sai dạng bị từ chối, không chạy handler; thiếu khoá thì chạy như client cũ", async () => {
    const { token } = runToken();
    const before = runs.count;
    const bad = await call(token, "task_update", { note: "x" }, { "Idempotency-Key": "short" });
    expect(bad.isError).toBe(true);
    expect(runs.count).toBe(before);
    const old = await call(token, "task_update", { note: "x" });
    expect(old.isError).toBe(false);
    expect(old.event).toBeUndefined();
    expect(runs.count).toBe(before + 1);
  });
});
