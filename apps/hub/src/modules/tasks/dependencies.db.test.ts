import { randomBytes, randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import type { Auth } from "../identity/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { setTaskDependencies } from "./dependencies.ts";
import { tasksRouter } from "./router.ts";
import { createSystemTask, createTask, getTask, listTasks, updateChecklist, updateTask } from "./tasks.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

let org: OrgFixture & { user: (n: string) => string };
/** Dự án của đội chính (tmember là thành viên, tviewer là người xem). */
let web = "";
/** Dự án của đội kia (oadmin quản trị; tviewer được thêm làm thành viên). */
let api = "";
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const newTask = (projectId: string, title: string) =>
  as("admin", (tx) => createTask(tx, org.user("admin"), { projectId, title, body: "" }));
const setDeps = (who: string | null, taskId: string, dependsOn: string[]) =>
  as(who ?? "admin", (tx) => setTaskDependencies(tx, who === null ? null : org.user(who), { taskId, dependsOn }));

beforeAll(async () => {
  org = await seedOrg(admin, `deps-${randomUUID().slice(0, 6)}`);
  ({ projectId: web } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: "web-shop",
  }));
  ({ projectId: api } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.otherTeamId,
    systemId: org.otherSystemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: "api",
  }));
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
    org.otherTeamId,
    org.orgId,
    org.user("tviewer"),
  ]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tasks.setDependencies", () => {
  it("thành viên đặt phụ thuộc trong dự án; get và list trả dependsOn, blockedBy; xong thì hết chặn; ghi audit", async () => {
    const a = await newTask(web, "Thiết kế");
    const b = await newTask(web, "Làm màn");
    await setDeps("tmember", b.id, [a.id, a.id]);

    const got = await as("tviewer", (tx) => getTask(tx, org.user("tviewer"), b.id));
    expect(got.dependsOn).toEqual([a.id]);
    expect(got.blockedBy).toEqual([
      { id: a.id, key: a.key, title: "Thiết kế", status: "todo", projectId: web, projectKey: "web-shop" },
    ]);
    const listed = await as("tmember", (tx) => listTasks(tx, org.user("tmember"), web));
    expect(listed.find((t) => t.id === b.id)?.blockedBy?.map((x) => x.id)).toEqual([a.id]);
    expect(listed.find((t) => t.id === a.id)).toMatchObject({ dependsOn: [], blockedBy: [] });

    await as("tmember", (tx) => updateTask(tx, org.user("tmember"), { id: a.id, status: "done" }));
    const after = await as("tmember", (tx) => getTask(tx, org.user("tmember"), b.id));
    expect(after).toMatchObject({ dependsOn: [a.id], blockedBy: [] });

    const { rows } = await admin.query(
      "select data from hive.audit_log where action = 'task.dependencies' and target_id = $1",
      [b.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ added: [a.key], removed: [], projectIds: [web], system: false });
  });

  it("thay cả danh sách: bỏ cạnh cũ, thêm cạnh mới; danh sách rỗng bỏ hết", async () => {
    const [a, b, c] = [await newTask(web, "A"), await newTask(web, "B"), await newTask(web, "C")];
    await setDeps("tmember", c.id, [a.id]);
    await setDeps("tmember", c.id, [b.id]);
    expect((await as("tmember", (tx) => getTask(tx, org.user("tmember"), c.id))).dependsOn).toEqual([b.id]);
    await setDeps("tmember", c.id, []);
    expect((await as("tmember", (tx) => getTask(tx, org.user("tmember"), c.id))).dependsOn).toEqual([]);
  });

  it("từ chối chu trình trong một dự án, chỉ ra đường vòng", async () => {
    const [a, b, c] = [await newTask(web, "A"), await newTask(web, "B"), await newTask(web, "C")];
    await setDeps("tmember", b.id, [a.id]);
    await setDeps("tmember", c.id, [b.id]);
    const err = await setDeps("tmember", a.id, [c.id]).catch((e: Error & { code: string }) => e);
    expect(err).toMatchObject({ code: "TASK_DEPENDENCY_CYCLE" });
    expect((err as Error).message).toBe(`Phụ thuộc vòng: ${a.key} → ${c.key} → ${b.key} → ${a.key}.`);
    expect(await errorCode(() => setDeps(null, a.id, [a.id]))).toBe("TASK_DEPENDENCY_CYCLE");
    expect((await as("tmember", (tx) => getTask(tx, org.user("tmember"), a.id))).dependsOn).toEqual([]);
  });

  it("từ chối chu trình trải hai dự án, kể cả với tác nhân hệ thống", async () => {
    const w = await newTask(web, "Màn web");
    const s = await newTask(api, "API");
    await setDeps("admin", w.id, [s.id]);
    const err = await setDeps(null, s.id, [w.id]).catch((e: Error & { code: string }) => e);
    expect(err).toMatchObject({ code: "TASK_DEPENDENCY_CYCLE" });
    expect((err as Error).message).toBe(`Phụ thuộc vòng: ${s.key} → ${w.key} → ${s.key}.`);
  });

  it("phụ thuộc khác dự án được khi có quyền sửa ở hai bên; blockedBy kèm key dự án; audit ghi hai dự án", async () => {
    const w = await newTask(web, "Màn thanh toán");
    const s = await newTask(api, "API thanh toán");
    await setDeps("admin", w.id, [s.id]);
    const got = await as("tmember", (tx) => getTask(tx, org.user("tmember"), w.id));
    expect(got.blockedBy).toEqual([
      { id: s.id, key: s.key, title: "API thanh toán", status: "todo", projectId: api, projectKey: "api" },
    ]);
    const { rows } = await admin.query(
      "select data from hive.audit_log where action = 'task.dependencies' and target_id = $1",
      [w.id],
    );
    expect(rows[0].data.projectIds.sort()).toEqual([web, api].sort());
  });

  it("thiếu quyền ở một bên thì bị từ chối, không ghi gì", async () => {
    const w = await newTask(web, "Màn đơn hàng");
    const s = await newTask(api, "API đơn hàng");
    // tmember không có vai trò ở đội của api: task bên kia như không tồn tại.
    expect(await errorCode(() => setDeps("tmember", w.id, [s.id]))).toBe("TASK_NOT_FOUND");
    // tviewer là thành viên đội api nhưng chỉ là người xem ở web.
    expect(await errorCode(() => setDeps("tviewer", s.id, [w.id]))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => setDeps("tviewer", w.id, [s.id]))).toBe("TEAM_ROLE_REQUIRED");
    // Bỏ cạnh liên dự án cũng đụng dự án bên kia nên cũng cần quyền ở đó.
    await setDeps("admin", w.id, [s.id]);
    expect(await errorCode(() => setDeps("tmember", w.id, []))).toBe("NOT_TEAM_MEMBER");
    const { rows } = await admin.query("select count(*)::int as n from hive.task_dependencies where task_id = $1", [
      w.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("tác nhân hệ thống bỏ qua kiểm quyền người", async () => {
    const w = await newTask(web, "Màn hệ thống");
    const s = await newTask(api, "API hệ thống");
    const { task, added } = await withTenant(app, { userId: org.user("loner"), orgId: org.orgId }, (tx) =>
      setTaskDependencies(tx, null, { taskId: w.id, dependsOn: [s.id] }),
    );
    expect(task.id).toBe(w.id);
    expect(added).toEqual([s.id]);
  });

  it("task đã huỷ không đặt được phụ thuộc; task không có trong tổ chức báo không tìm thấy", async () => {
    const a = await newTask(web, "Sẽ huỷ");
    await admin.query("update hive.tasks set status = 'cancelled' where id = $1", [a.id]);
    expect(await errorCode(() => setDeps("tmember", a.id, []))).toBe("TASK_CANCELLED");
    const b = await newTask(web, "Còn sống");
    expect(await errorCode(() => setDeps("tmember", b.id, [randomUUID()]))).toBe("TASK_NOT_FOUND");
  });

  it("phụ thuộc đã huỷ vẫn chặn", async () => {
    const a = await newTask(web, "Bị huỷ");
    const b = await newTask(web, "Chờ");
    await setDeps("tmember", b.id, [a.id]);
    await admin.query("update hive.tasks set status = 'cancelled' where id = $1", [a.id]);
    const got = await as("tmember", (tx) => getTask(tx, org.user("tmember"), b.id));
    expect(got.blockedBy?.map((x) => x.status)).toEqual(["cancelled"]);
  });

  it("xoá task xoá cạnh ở cả hai đầu", async () => {
    const a = await newTask(web, "Gốc");
    const b = await newTask(web, "Giữa");
    const c = await newTask(api, "Ngọn");
    await setDeps("admin", b.id, [a.id]);
    await setDeps("admin", c.id, [b.id]);
    await admin.query("delete from hive.tasks where id = $1", [b.id]);
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.task_dependencies where task_id = $1 or depends_on_id = $1",
      [b.id],
    );
    expect(rows[0].n).toBe(0);
    expect((await as("admin", (tx) => getTask(tx, org.user("admin"), c.id))).blockedBy).toEqual([]);
  });

  it("route setDependencies trả task kèm phụ thuộc", async () => {
    const a = await newTask(web, "Route A");
    const b = await newTask(web, "Route B");
    const userId = org.user("tmember");
    const router = tasksRouter({
      pool: app,
      auth: {
        api: { getSession: async () => ({ user: { id: userId, name: userId, email: `${userId}@seed.test` } }) },
      } as unknown as Auth,
    });
    const task = await call(
      router.setDependencies,
      { taskId: b.id, dependsOn: [a.id] },
      { context: { headers: new Headers({ "x-hive-org": org.orgId }) } },
    );
    expect(task).toMatchObject({ id: b.id, dependsOn: [a.id], blockedBy: [{ id: a.id }] });
  });
});

describe("checklist", () => {
  const item = (id: string, text: string) => ({ id, text, done: false, requirementIds: [] });

  it("task hệ thống tạo kèm checklist; get và list trả checklist; task tạo tay có checklist rỗng", async () => {
    const row = await as("admin", (tx) =>
      createSystemTask(
        tx,
        "sdlc",
        {
          projectId: web,
          title: "Có checklist",
          body: "",
          checklist: [{ ...item("c1", "Viết test"), requirementIds: ["FR-001"] }],
        },
        { kind: "sdlc" },
      ),
    );
    const got = await as("tviewer", (tx) => getTask(tx, org.user("tviewer"), row.id));
    expect(got.checklist).toEqual([{ id: "c1", text: "Viết test", done: false, requirementIds: ["FR-001"] }]);
    const plain = await newTask(web, "Không checklist");
    expect(plain.checklist).toEqual([]);
  });

  it("thành viên thay checklist; id trùng bị từ chối", async () => {
    const t = await newTask(web, "Sửa checklist");
    const updated = await as("tmember", (tx) =>
      updateTask(tx, org.user("tmember"), { id: t.id, checklist: [item("a", "Một"), item("b", "Hai")] }),
    );
    expect(updated.checklist?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          updateTask(tx, org.user("tmember"), { id: t.id, checklist: [item("a", "Một"), item("a", "Lặp")] }),
        ),
      ),
    ).toBe("TASK_CHECKLIST_DUPLICATE");
    expect(
      await errorCode(() => as("tviewer", (tx) => updateTask(tx, org.user("tviewer"), { id: t.id, checklist: [] }))),
    ).toBe("TEAM_ROLE_REQUIRED");
  });

  it("updateChecklist đánh dấu theo id, giữ chữ; id lạ bị từ chối cả lần", async () => {
    const t = await newTask(web, "Đánh dấu");
    await as("tmember", (tx) =>
      updateTask(tx, org.user("tmember"), { id: t.id, checklist: [item("a", "Một"), item("b", "Hai")] }),
    );
    const row = await as("admin", (tx) => updateChecklist(tx, t.id, [{ id: "b", done: true }]));
    expect(row.checklist.map((c) => [c.id, c.text, c.done])).toEqual([
      ["a", "Một", false],
      ["b", "Hai", true],
    ]);
    expect(
      await errorCode(() =>
        as("admin", (tx) =>
          updateChecklist(tx, t.id, [
            { id: "a", done: true },
            { id: "x", done: true },
          ]),
        ),
      ),
    ).toBe("TASK_CHECKLIST_ITEM_NOT_FOUND");
    const got = await as("admin", (tx) => getTask(tx, org.user("admin"), t.id));
    expect(got.checklist?.map((c) => c.done)).toEqual([false, true]);
  });
});
