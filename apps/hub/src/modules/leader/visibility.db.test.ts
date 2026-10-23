import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { chatThreads } from "./schema.ts";
import { createThread, listApprovals, rejectApproval } from "./service.ts";
import { delegationTree } from "./tree.ts";
import { requireThreadAccess, visibleThreadsWhere } from "./visibility.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
const ids = { home: "", other: "", homeThread: "", otherThread: "", viewerLoose: "", lonerLoose: "" };

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));

async function thread(projectId: string | null, by: string, title: string) {
  const { rows } = await admin.query(
    "insert into hive.chat_threads (org_id, project_id, created_by, title) values ($1, $2, $3, $4) returning id",
    [org.orgId, projectId, org.user(by), title],
  );
  return rows[0].id as string;
}

async function approval(threadId: string) {
  const { rows } = await admin.query(
    `insert into hive.approvals (org_id, thread_id, action, expires_at)
     values ($1, $2, '{"type":"run.cancel","runId":"00000000-0000-0000-0000-000000000000"}', now() + interval '1 hour')
     returning id`,
    [org.orgId, threadId],
  );
  return rows[0].id as string;
}

const titles = (who: string) =>
  as(who, async (tx, userId) =>
    (
      await tx
        .select({ title: chatThreads.title })
        .from(chatThreads)
        .where(await visibleThreadsWhere(tx, userId))
    )
      .map((r) => r.title)
      .sort(),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `leader-vis-${tag}`);
  const seed = (teamId: string, systemId: string, key: string) =>
    seedProject(admin, app, { orgId: org.orgId, teamId, systemId, adminUserId: org.user("admin"), masterKey, key });
  ids.home = (await seed(org.teamId, org.systemId, `lv${tag}h`)).projectId;
  ids.other = (await seed(org.otherTeamId, org.otherSystemId, `lv${tag}o`)).projectId;
  ids.homeThread = await thread(ids.home, "tmember", "home");
  ids.otherThread = await thread(ids.other, "oadmin", "other");
  ids.viewerLoose = await thread(null, "tviewer", "viewer-loose");
  ids.lonerLoose = await thread(null, "loner", "loner-loose");
});

afterAll(async () => Promise.all([admin.end(), app.end()]));

describe("hội thoại Leader thấy được theo đội (spec 034 FR-090)", () => {
  it("thành viên chỉ thấy hội thoại của đội mình và hội thoại không dự án do mình tạo", async () => {
    expect(await titles("tviewer")).toEqual(["home", "viewer-loose"]);
    expect(await titles("tmember")).toEqual(["home"]);
    expect(await titles("oadmin")).toEqual(["other"]);
    expect(await titles("loner")).toEqual(["loner-loose"]);
  });

  it("owner và admin tổ chức thấy mọi hội thoại", async () => {
    expect(await titles("admin")).toEqual(["home", "loner-loose", "other", "viewer-loose"]);
    expect(await titles("owner")).toHaveLength(4);
  });

  it("mở hội thoại không thấy được thì báo không tồn tại", async () => {
    const [home] = await as("owner", (tx) => tx.select().from(chatThreads).where(eq(chatThreads.id, ids.homeThread)));
    if (!home) throw new Error("thiếu hội thoại");
    expect(await errorCode(() => as("loner", (tx, u) => requireThreadAccess(tx, u, home)))).toBe(
      "LEADER_THREAD_NOT_FOUND",
    );
    expect(await errorCode(() => as("oadmin", (tx, u) => delegationTree(tx, u, ids.homeThread)))).toBe(
      "LEADER_THREAD_NOT_FOUND",
    );
    await as("tviewer", (tx, u) => requireThreadAccess(tx, u, home));
  });

  it("danh sách đề xuất chỉ gồm hội thoại thấy được", async () => {
    const homeApproval = await approval(ids.homeThread);
    const otherApproval = await approval(ids.otherThread);
    const seen = async (who: string) =>
      (await as(who, (tx, u) => listApprovals(tx, u, "pending"))).map((a) => a.id).sort();
    expect(await seen("tmember")).toEqual([homeApproval]);
    expect(await seen("oadmin")).toEqual([otherApproval]);
    expect(await seen("admin")).toEqual([homeApproval, otherApproval].sort());
  });

  it("từ chối đề xuất cần vai trò thành viên của đội", async () => {
    const id = await approval(ids.homeThread);
    expect(await errorCode(() => as("tviewer", (tx, u) => rejectApproval(tx, u, id, "không")))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    expect(await errorCode(() => as("oadmin", (tx, u) => rejectApproval(tx, u, id, "không")))).toBe(
      "LEADER_THREAD_NOT_FOUND",
    );
    const rejected = await as("tmember", (tx, u) => rejectApproval(tx, u, id, "chưa cần"));
    expect(rejected.status).toBe("rejected");
  });

  it("không tạo được hội thoại cho dự án của đội mình không có vai trò", async () => {
    expect(
      await errorCode(() => as("tmember", (tx, u) => createThread(tx, u, { projectId: ids.other, title: "x" }))),
    ).toBe("NOT_TEAM_MEMBER");
    const created = await as("tmember", (tx, u) => createThread(tx, u, { projectId: ids.home, title: "y" }));
    expect(created.projectId).toBe(ids.home);
  });
});
