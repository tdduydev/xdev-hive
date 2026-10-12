import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { tasks } from "./schema.ts";
import { cancelTask, createTask, getTask, listTasks, updateTask } from "./tasks.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
let projectId = "";
let otherOrgProject = "";
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

beforeAll(async () => {
  org = await seedOrg(admin, `tasks-${randomUUID().slice(0, 6)}`);
  other = await seedOrg(admin, `tasks2-${randomUUID().slice(0, 6)}`);
  ({ projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: "hoa-don",
  }));
  ({ projectId: otherOrgProject } = await seedProject(admin, app, {
    orgId: other.orgId,
    teamId: other.teamId,
    systemId: other.systemId,
    adminUserId: other.user("admin"),
    masterKey,
    key: "khac",
  }));
  await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
     values ($1, $2, $3, 1, 'khac-1', 'Task tổ chức khác', 'u')`,
    [other.orgId, other.teamId, otherOrgProject],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tasks.create", () => {
  it("thành viên đội tạo được; key theo dự án, số tăng dần, ghi audit", async () => {
    const a = await as("tmember", (tx) =>
      createTask(tx, org.user("tmember"), { projectId, title: "Sửa lỗi hoá đơn", body: "Chi tiết" }),
    );
    const b = await as("tmember", (tx) =>
      createTask(tx, org.user("tmember"), { projectId, title: "Thêm báo cáo", body: "" }),
    );
    expect(a).toMatchObject({
      key: `hoa-don-${a.number}`,
      status: "todo",
      teamId: org.teamId,
      createdBy: org.user("tmember"),
    });
    expect(b.number).toBe(a.number + 1);
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.audit_log where action = 'task.create' and target_id = $1",
      [a.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("tạo song song không trùng số thứ tự", async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        as("tmember", (tx) => createTask(tx, org.user("tmember"), { projectId, title: `Song song ${i}`, body: "" })),
      ),
    );
    expect(new Set(made.map((t) => t.number)).size).toBe(5);
  });

  it("người xem và người ngoài đội không tạo được", async () => {
    expect(
      await errorCode(() =>
        as("tviewer", (tx) => createTask(tx, org.user("tviewer"), { projectId, title: "x", body: "" })),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(
      await errorCode(() =>
        as("oadmin", (tx) => createTask(tx, org.user("oadmin"), { projectId, title: "x", body: "" })),
      ),
    ).toBe("PROJECT_NOT_FOUND");
  });
});

describe("tasks đọc, sửa, huỷ", () => {
  it("người xem đọc được nhưng không sửa được", async () => {
    const t = await as("tmember", (tx) => createTask(tx, org.user("tmember"), { projectId, title: "Đọc", body: "" }));
    expect((await as("tviewer", (tx) => getTask(tx, org.user("tviewer"), t.id))).title).toBe("Đọc");
    const list = await as("tviewer", (tx) => listTasks(tx, org.user("tviewer"), projectId));
    expect(list.map((x) => x.id)).toContain(t.id);
    expect(
      await errorCode(() => as("tviewer", (tx) => updateTask(tx, org.user("tviewer"), { id: t.id, title: "Đổi" }))),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => as("oadmin", (tx) => getTask(tx, org.user("oadmin"), t.id)))).toBe("TASK_NOT_FOUND");
  });

  it("sửa tiêu đề, trạng thái tay; lọc theo trạng thái", async () => {
    const t = await as("tmember", (tx) => createTask(tx, org.user("tmember"), { projectId, title: "Sửa", body: "" }));
    const u = await as("tmember", (tx) =>
      updateTask(tx, org.user("tmember"), { id: t.id, title: "Đã sửa", status: "done", preferredCli: "codex" }),
    );
    expect(u).toMatchObject({ title: "Đã sửa", status: "done", preferredCli: "codex" });
    const done = await as("tmember", (tx) => listTasks(tx, org.user("tmember"), projectId, "done"));
    expect(done.every((x) => x.status === "done")).toBe(true);
    expect(done.map((x) => x.id)).toContain(t.id);
  });

  it("việc của tôi: task mình tạo hoặc có run mình là chủ, không lấy task của người khác", async () => {
    const mineCreated = await as("tmember", (tx) =>
      createTask(tx, org.user("tmember"), { projectId, title: "Của tôi", body: "" }),
    );
    const mineByRun = await as("tadmin", (tx) =>
      createTask(tx, org.user("tadmin"), { projectId, title: "Giao tôi", body: "" }),
    );
    const others = await as("tadmin", (tx) =>
      createTask(tx, org.user("tadmin"), { projectId, title: "Người khác", body: "" }),
    );
    await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by, owner_user_id)
       select org_id, team_id, id, project_id, 'code', 'succeeded', 'ai/x', '[]', $2, $2 from hive.tasks where id = $1`,
      [mineByRun.id, org.user("tmember")],
    );
    const list = await as("tmember", (tx) => listTasks(tx, org.user("tmember"), undefined, undefined, true));
    const ids = list.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([mineCreated.id, mineByRun.id]));
    expect(ids).not.toContain(others.id);
  });

  it("huỷ task gọi huỷ run và không sửa được nữa", async () => {
    const t = await as("tmember", (tx) => createTask(tx, org.user("tmember"), { projectId, title: "Huỷ", body: "" }));
    let called = "";
    const { task } = await as("tmember", (tx) =>
      cancelTask(tx, org.user("tmember"), t.id, async (_tx, id) => {
        called = id;
        return () => {};
      }),
    );
    expect(task.status).toBe("cancelled");
    expect(called).toBe(t.id);
    expect(
      await errorCode(() => as("tmember", (tx) => updateTask(tx, org.user("tmember"), { id: t.id, title: "x" }))),
    ).toBe("TASK_CANCELLED");
  });
});

describe("RLS bảng tasks", () => {
  it("không có context thì 0 dòng; context tổ chức chỉ thấy tổ chức đó", async () => {
    await withTenant(app, {}, async (tx) => expect(await tx.select().from(tasks)).toHaveLength(0));
    await withTenant(app, { orgId: org.orgId }, async (tx) => {
      const rows = await tx.select().from(tasks);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === org.orgId)).toBe(true);
    });
  });

  it("không ghi được task cho tổ chức khác, UPDATE không chuyển được sang tổ chức khác", async () => {
    const values = {
      orgId: other.orgId,
      teamId: other.teamId,
      projectId: otherOrgProject,
      number: 99,
      key: "khac-99",
      title: "x",
      createdBy: "u",
    };
    expect(await pgCode(() => withTenant(app, { orgId: org.orgId }, (tx) => tx.insert(tasks).values(values)))).toBe(
      "42501",
    );
    const [mine] = await withTenant(app, { orgId: org.orgId }, (tx) => tx.select().from(tasks).limit(1));
    expect(
      await pgCode(() =>
        withTenant(app, { orgId: org.orgId }, (tx) =>
          tx
            .update(tasks)
            .set({ orgId: other.orgId })
            .where(eq(tasks.id, mine?.id ?? "")),
        ),
      ),
    ).toBe("42501");
  });

  it("task không trỏ được tới dự án của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: org.orgId }, (tx) =>
        tx.insert(tasks).values({
          orgId: org.orgId,
          teamId: org.teamId,
          projectId: otherOrgProject,
          number: 999,
          key: "x-999",
          title: "x",
          createdBy: "u",
        }),
      ),
    );
    expect(code).toBe("23503");
  });
});
