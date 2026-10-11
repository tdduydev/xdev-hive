import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { approvals, chatMessages, chatThreads } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const orgs: Record<"a" | "b", { orgId: string }> = {} as never;
const threadIds: Record<"a" | "b", string> = {} as never;
const tables = [chatThreads, chatMessages, approvals];

beforeAll(async () => {
  for (const name of ["a", "b"] as const) {
    const org = await seedOrg(admin, `leader-rls-${name}-${randomUUID().slice(0, 6)}`);
    orgs[name] = { orgId: org.orgId };
    const { rows } = await admin.query(
      "insert into hive.chat_threads (org_id, created_by, title) values ($1, 'user', 'thread') returning id",
      [org.orgId],
    );
    threadIds[name] = rows[0].id;
    await admin.query(
      "insert into hive.chat_messages (org_id, thread_id, role, content) values ($1, $2, 'user', 'hello')",
      [org.orgId, rows[0].id],
    );
    await admin.query(
      'insert into hive.approvals (org_id, thread_id, action, expires_at) values ($1, $2, \'{"type":"run.cancel","runId":"00000000-0000-0000-0000-000000000000"}\', now() + interval \'1 hour\')',
      [org.orgId, rows[0].id],
    );
  }
});

afterAll(async () => Promise.all([admin.end(), app.end()]));

describe("RLS bảng leader", () => {
  it("không có tenant context thì không thấy thread, message hoặc approval", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
    });
  });

  it("chỉ đọc được tenant hiện tại và không ghi chéo tenant", async () => {
    await withTenant(app, { orgId: orgs.a.orgId }, async (tx) => {
      for (const table of tables)
        expect((await tx.select().from(table)).every((row) => row.orgId === orgs.a.orgId)).toBe(true);
      await expect(
        tx.insert(chatMessages).values({ orgId: orgs.b.orgId, threadId: threadIds.b, role: "user", content: "no" }),
      ).rejects.toBeDefined();
    });
  });
});
