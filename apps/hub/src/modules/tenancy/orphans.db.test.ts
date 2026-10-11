import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { freshDatabase } from "../../../test/seed.ts";
import { createJobs, createPool, type Jobs } from "../platform/index.ts";
import {
  ORPHAN_USERS_CRON,
  ORPHAN_USERS_QUEUE,
  orphanUsersQueue,
  purgeOrphanUsers,
  registerOrphanUsersWorker,
} from "./orphans.ts";

// Database riêng: hàm xoá người dùng trên toàn hub, không được đụng người dùng của file test khác.
const db = inject("db");
let admin: pg.Pool;
let app: pg.Pool;
let jobs: Jobs | undefined;
const sharedAdmin = new pg.Pool({ connectionString: db.adminUrl });
const orgId = randomUUID();

const OLD = "now() - interval '8 days'";

async function user(id: string, opts: { email?: string; createdAt?: string } = {}) {
  await admin.query(
    `insert into auth."user" (id, name, email, "createdAt") values ($1, $1, $2, ${opts.createdAt ?? OLD})`,
    [id, opts.email ?? `${id}@example.com`],
  );
}

async function invite(email: string, opts: { expiresAt?: string; acceptedAt?: string } = {}) {
  await admin.query(
    `insert into hive.invitations (org_id, email, token_hash, expires_at, accepted_at, created_by)
     values ($1, $2, $3, ${opts.expiresAt ?? "now() + interval '7 days'"}, ${opts.acceptedAt ?? "null"}, 'chu')`,
    [orgId, email, randomUUID()],
  );
}

async function existing(): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(`select id from auth."user"`);
  return rows.map((r) => r.id).sort();
}

beforeAll(async () => {
  const urls = await freshDatabase(db);
  admin = new pg.Pool({ connectionString: urls.adminUrl });
  app = createPool(urls.appUrl);

  await user("chu");
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, 'a', 'A', 'chu')", [orgId]);
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, 'chu', 'owner')", [orgId]);

  // Bị xoá: không tổ chức, không lời mời đang chờ, tạo quá 7 ngày.
  await user("mo-coi");
  await admin.query(
    `insert into auth.session (id, "expiresAt", token, "userId") values ('s-mo-coi', now() + interval '1 day', 't-mo-coi', 'mo-coi')`,
  );
  await admin.query(
    `insert into auth.account (id, "accountId", "providerId", "userId") values ('a-mo-coi', '1', 'github', 'mo-coi')`,
  );
  await user("loi-moi-het-han");
  await invite("loi-moi-het-han@example.com", { expiresAt: "now() - interval '1 day'" });
  await user("loi-moi-da-dung");
  await invite("loi-moi-da-dung@example.com", { acceptedAt: "now() - interval '1 day'" });

  // Giữ lại.
  await user("moi-tao", { createdAt: "now() - interval '6 days'" });
  await user("thanh-vien");
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, 'thanh-vien', 'member')", [
    orgId,
  ]);
  await user("cho-duyet");
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role, status) values ($1, 'cho-duyet', 'member', 'pending')",
    [orgId],
  );
  await user("bi-khoa");
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role, status) values ($1, 'bi-khoa', 'member', 'blocked')",
    [orgId],
  );
  // Email lưu chữ thường; lời mời cũng vậy.
  await user("dang-duoc-moi");
  await invite("dang-duoc-moi@example.com");
  await user("quan-tri-hub");
  // Nhà cung cấp SSO bị xoá theo người đăng ký (ON DELETE CASCADE), nên người đó được giữ.
  await user("dang-ky-sso");
  await admin.query(
    `insert into auth."ssoProvider" (id, issuer, "providerId", domain, "userId")
     values ('p1', 'https://idp.example.com', 'org-x', 'mo-coi.test', 'dang-ky-sso')`,
  );
  // Khoá ngoại không cascade (client MCP): xoá sẽ hỏng, nên bỏ qua.
  await user("client-mcp");
  await admin.query(
    `insert into auth."oauthClient" (id, "clientId", "redirectUris", "userId") values ('c1', 'c1', '[]', 'client-mcp')`,
  );
});

afterAll(async () => {
  await jobs?.stop();
  await Promise.all([admin?.end(), app?.end(), sharedAdmin.end()]);
});

const KEPT = [
  "bi-khoa",
  "cho-duyet",
  "chu",
  "client-mcp",
  "dang-duoc-moi",
  "dang-ky-sso",
  "moi-tao",
  "quan-tri-hub",
  "thanh-vien",
];

describe("dọn tài khoản không thuộc tổ chức nào", () => {
  it("xoá đúng tài khoản mồ côi quá 7 ngày, kèm phiên và liên kết; giữ người quản trị hub (khác hoa thường)", async () => {
    expect(await purgeOrphanUsers(app, { keepEmails: [" Quan-Tri-Hub@Example.com "] })).toBe(3);
    expect(await existing()).toEqual(KEPT);
    const { rows } = await admin.query(
      `select (select count(*)::int from auth.session where "userId" = 'mo-coi') as sessions,
              (select count(*)::int from auth.account where "userId" = 'mo-coi') as accounts,
              (select count(*)::int from auth."ssoProvider") as providers`,
    );
    expect(rows[0]).toEqual({ sessions: 0, accounts: 0, providers: 1 });
  });

  it("chạy lại không xoá thêm gì (idempotent)", async () => {
    expect(await purgeOrphanUsers(app, { keepEmails: ["quan-tri-hub@example.com"] })).toBe(0);
    expect(await existing()).toEqual(KEPT);
  });

  it("lời mời hết hạn hoặc bị thu hồi thì lần chạy sau mới xoá", async () => {
    await admin.query("delete from hive.invitations where email = 'dang-duoc-moi@example.com'");
    expect(await purgeOrphanUsers(app, { keepEmails: ["quan-tri-hub@example.com"] })).toBe(1);
    expect(await existing()).not.toContain("dang-duoc-moi");
  });

  it("chỉ hive_app gọi được hàm; hive_app vẫn không đọc được thành viên của tổ chức khác", async () => {
    const { rows } = await admin.query(
      `select has_function_privilege('hive_app', 'hive.purge_orphan_users(text[])', 'execute') as app,
              has_function_privilege('hive_auth', 'hive.purge_orphan_users(text[])', 'execute') as auth`,
    );
    expect(rows[0]).toEqual({ app: true, auth: false });
    const seen = await app.query("select count(*)::int as n from hive.org_members");
    expect(seen.rows[0].n).toBe(0);
  });

  it("worker chạy theo hàng đợi pg-boss và đặt lịch hằng ngày", async () => {
    await user("mo-coi-2");
    jobs = createJobs({ connectionString: db.jobsUrl, queues: [orphanUsersQueue], maintenance: false });
    await jobs.start();
    await registerOrphanUsersWorker(
      jobs,
      { pool: app, keepEmails: ["quan-tri-hub@example.com"] },
      {
        pollingIntervalSeconds: 0.5,
      },
    );
    const { rows } = await sharedAdmin.query("select cron from pgboss.schedule where name = $1", [ORPHAN_USERS_QUEUE]);
    expect(rows).toEqual([{ cron: ORPHAN_USERS_CRON }]);
    await jobs.enqueue(ORPHAN_USERS_QUEUE, {});
    await expect.poll(existing, { timeout: 15_000 }).not.toContain("mo-coi-2");
    expect(await existing()).toContain("quan-tri-hub");
  });
});
