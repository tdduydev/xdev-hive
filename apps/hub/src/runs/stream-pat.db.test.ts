import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../test/org-fixture.ts";
import { seedProject } from "../../test/project-fixture.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../modules/identity/index.ts";
import { createPool, parseMasterKey } from "../modules/platform/index.ts";
import { RunNotifier } from "../modules/runs/index.ts";

const { adminUrl, appUrl, authUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const authPool = createPool(authUrl);
const notifier = new RunNotifier(pool);
const baseURL = "http://hive.test";
const app = createApp({
  config: { port: 0, version: "test", publicUrl: baseURL },
  pool,
  runNotifier: notifier,
  auth: createAuth({ pool: authPool, baseURL, secret: "test-secret-0123456789abcdef-0123456789" }),
});
let org: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
let runId: string;
let token: string;
let eventId: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  org = await seedOrg(admin, `streampat-${tag}`);
  other = await seedOrg(admin, `streampat-other-${tag}`);
  const { projectId } = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("owner"),
    masterKey: parseMasterKey(randomBytes(32).toString("base64")),
    key: `sse-${tag}`,
  });
  // Run leader không cần task; quyền đọc vẫn được kiểm qua dự án và thành viên đội.
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, kind, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, 'leader', 'succeeded', 'main', '[]', $4) returning id`,
    [org.orgId, org.teamId, projectId, org.user("tmember")],
  );
  runId = run.rows[0].id;
  const event = await admin.query(
    `insert into hive.run_events (org_id, run_id, attempt, type, data) values ($1, $2, 1, 'state', '{"state":"succeeded"}') returning id`,
    [org.orgId, runId],
  );
  eventId = String(event.rows[0].id);
  token = await pat(org.orgId, org.user("tmember"));
});

afterAll(async () => {
  await notifier.close();
  await Promise.all([admin.end(), pool.end(), authPool.end()]);
});

async function pat(orgId: string, userId: string, revoked = false, expired = false) {
  const value = `hive_pat_${orgId}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(value).digest("hex");
  await admin.query(
    `insert into hive.mcp_user_tokens (org_id, user_id, token_hash, prefix, client_id, expires_at, revoked_at)
     values ($1, $2, $3, 'hive_pat_test', 'xdev-hive-cli', now() + interval '90 days', $4)`,
    [orgId, userId, hash, revoked ? new Date() : null],
  );
  if (expired)
    await admin.query(
      `update hive.mcp_user_tokens set created_at = now() - interval '91 days', expires_at = now() - interval '1 day' where token_hash = $1`,
      [hash],
    );
  return value;
}
const call = (value: string | undefined, orgId = org.orgId, cursor?: string) =>
  app.request(`/api/v1/runs/${runId}/stream`, {
    headers: {
      "x-hive-org": orgId,
      ...(value ? { authorization: `Bearer ${value}` } : {}),
      ...(cursor ? { "Last-Event-ID": cursor } : {}),
    },
  });

describe("SSE với PAT purpose=cli", () => {
  it("không cần cookie; gửi sự kiện và chỉ phần sau Last-Event-ID", async () => {
    const response = await call(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain(`id: ${eventId}.0`);
    expect(body).toContain("event: run_event");
    expect(body).toContain("event: end");
    const resumed = await call(token, org.orgId, `${eventId}.0`);
    const tail = await resumed.text();
    expect(tail).not.toContain("event: run_event");
    expect(tail).toContain("event: end");
  });
  it("từ chối token thiếu, sai, hết hạn, thu hồi và khác tổ chức", async () => {
    for (const value of [
      undefined,
      `${token}invalid`,
      await pat(org.orgId, org.user("tmember"), true),
      await pat(org.orgId, org.user("tmember"), false, true),
    ]) {
      expect((await call(value)).status).toBe(401);
    }
    expect((await call(token, other.orgId)).status).toBe(401);
    expect((await call(await pat(other.orgId, other.user("tmember")), other.orgId)).status).toBe(404);
  });
  it("PAT hợp lệ vẫn phải có quyền xem đội của run", async () => {
    expect((await call(await pat(org.orgId, org.user("oadmin")))).status).toBe(404);
  });
});
