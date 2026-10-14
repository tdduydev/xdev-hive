import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  projectSdlcSettings,
  type ReviewPhase,
  reviewPhase,
  SDLC_PRESETS,
  type SdlcMode,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  addItemProject,
  expandPerProjectGates,
  type ItemTeam,
  insertItemProjects,
  itemTeams,
  perTeamWorkflow,
  removeItemProject,
  resolveItemProjects,
} from "./participants.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let teamC = "";
let systemC = "";
const p: Record<"a" | "b" | "b2" | "c" | "off" | "archived", string> = {
  a: "",
  b: "",
  b2: "",
  c: "",
  off: "",
  archived: "",
};
const key = (k: string) => `${k}${tag}`;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

async function addUser(name: string, memberships: [team: string, role: string][]) {
  const id = org.user(name);
  await admin.query(
    `insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test') on conflict do nothing`,
    [id],
  );
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [org.orgId, id]);
  for (const [team, role] of memberships)
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, $4)", [
      team,
      org.orgId,
      id,
      role,
    ]);
}

async function seedSdlcProject(k: string, teamId: string, systemId: string, sdlc: Record<string, unknown> | null) {
  const settings = { ...defaultProjectSettings(), ...(sdlc ? { sdlc: projectSdlcSettings.parse(sdlc) } : {}) };
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings,
    })
  ).projectId;
}

let n = 0;
/** Dòng hạng mục chèn bằng superuser (items.create là của T012); dòng dự án ghi bằng resolve/insert thật. */
async function seedItem(creator: string, home: string, participants: string[], status = "active"): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.sdlc_items (org_id, team_id, project_id, number, slug, title, idea, source, mode_ref, mode,
       settings, size, status, owner_user_id, created_by)
     select $1, pr.team_id, pr.id, $3, 'hoan-tien', 'Hoàn tiền một phần', 'Ý tưởng đủ dài để qua kiểm tra',
       '{"kind":"manual"}', 'speckit', $4, '{}', 'M', $6, $5, $5
     from hive.projects pr where pr.id = $2 returning id`,
    [org.orgId, home, ++n, JSON.stringify(SDLC_PRESETS.speckit as SdlcMode), org.user(creator), status],
  );
  const itemId = rows[0].id as string;
  await as(creator, async (tx) =>
    insertItemProjects(
      tx,
      itemId,
      await resolveItemProjects(tx, org.user(creator), { projectId: home, participants }),
      org.user(creator),
    ),
  );
  return itemId;
}

async function itemProjects(itemId: string) {
  const { rows } = await admin.query(
    `select project_id as "projectId", team_id as "teamId", role, settings, added_by as "addedBy",
       removed_at as "removedAt"
     from hive.sdlc_item_projects where item_id = $1 order by role = 'home' desc, added_at`,
    [itemId],
  );
  return rows as {
    projectId: string;
    teamId: string;
    role: string;
    settings: { maxParallel: number };
    addedBy: string;
    removedAt: Date | null;
  }[];
}

async function seedTask(projectId: string, teamId: string, status = "todo"): Promise<string> {
  const number = ++n;
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, $4, $5, 'Task', $6, 'seed') returning id`,
    [org.orgId, teamId, projectId, number, `T-${tag}-${number}`, status],
  );
  return rows[0].id as string;
}

async function linkTask(itemId: string, taskId: string, projectId: string) {
  await admin.query(
    `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
     values ($1, $2, $3, $4, $5, 1, 1)`,
    [org.orgId, itemId, taskId, projectId, `T${++n}`],
  );
}

async function seedRun(taskId: string, projectId: string, teamId: string) {
  await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
     values ($1, $2, $3, $4, 'code', 'failed', 'ai/x', '[]', 'seed')`,
    [org.orgId, teamId, taskId, projectId],
  );
}

const audits = async (action: string, itemId: string) =>
  (
    await admin.query("select data from hive.audit_log where action = $1 and target_id = $2", [action, itemId])
  ).rows.map((r) => r.data as Record<string, unknown>);

beforeAll(async () => {
  org = await seedOrg(admin, `sdp-${tag}`);
  teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id;
  // seedOrg: tadmin/tmember ở đội A (thanh-toan), oadmin quản trị đội B (crm).
  await addUser("both", [
    [org.teamId, "member"],
    [org.otherTeamId, "member"],
  ]);
  await addUser("cadmin", [[teamC, "admin"]]);
  await addUser("bviewer", [[org.otherTeamId, "viewer"]]);
  p.a = await seedSdlcProject("a", org.teamId, org.systemId, { enabled: true });
  p.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId, { enabled: true, maxParallel: 3 });
  p.b2 = await seedSdlcProject("bb", org.otherTeamId, org.otherSystemId, { enabled: true });
  p.c = await seedSdlcProject("c", teamC, systemC, { enabled: true });
  p.off = await seedSdlcProject("off", org.otherTeamId, org.otherSystemId, null);
  p.archived = await seedSdlcProject("arc", org.otherTeamId, org.otherSystemId, { enabled: true });
  await admin.query("update hive.projects set state = 'archived' where id = $1", [p.archived]);
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("resolveItemProjects (items.create)", () => {
  const resolve = (who: string, participants: string[], home = p.a) =>
    as(who, (tx) => resolveItemProjects(tx, org.user(who), { projectId: home, participants }));

  it("ghi dự án chính và dự án tham gia, mỗi dòng chụp cài đặt của dự án đó", async () => {
    const item = await seedItem("both", p.a, [p.b, p.b2]);
    const rows = await itemProjects(item);
    expect(rows.map((r) => [r.projectId, r.role, r.teamId])).toEqual([
      [p.a, "home", org.teamId],
      [p.b, "participant", org.otherTeamId],
      [p.b2, "participant", org.otherTeamId],
    ]);
    expect(rows.find((r) => r.projectId === p.b)?.settings.maxParallel).toBe(3);
    expect(rows.find((r) => r.projectId === p.a)?.settings.maxParallel).toBe(2);
    expect(rows.every((r) => r.addedBy === org.user("both"))).toBe(true);
  });

  it("thiếu quyền ở một dự án thì từ chối cả yêu cầu", async () => {
    expect(await errorCode(() => resolve("tmember", [p.b]))).toBe("SDLC_FORBIDDEN");
  });

  it("dự án chưa bật AI SDLC hoặc đã lưu trữ thì không thêm được", async () => {
    expect(await errorCode(() => resolve("both", [p.off]))).toBe("SDLC_PROJECT_DISABLED");
    expect(await errorCode(() => resolve("both", [p.archived]))).toBe("SDLC_PROJECT_DISABLED");
  });

  it("tối đa 8 dự án, không trùng", async () => {
    const many = Array.from({ length: 8 }, () => randomUUID());
    expect(await errorCode(() => resolve("both", many))).toBe("SDLC_TOO_MANY_PROJECTS");
    expect(await errorCode(() => resolve("both", [p.b, p.b]))).toBe("SDLC_DUPLICATE_PROJECT");
    expect(await errorCode(() => resolve("both", [p.a]))).toBe("SDLC_DUPLICATE_PROJECT");
  });

  it("dự án của tổ chức khác coi như không có", async () => {
    const other = await seedOrg(admin, `sdp2-${tag}`);
    const foreign = (
      await seedProject(admin, app, {
        orgId: other.orgId,
        teamId: other.teamId,
        systemId: other.systemId,
        adminUserId: other.user("admin"),
        masterKey,
        key: key("x"),
        settings: { ...defaultProjectSettings(), sdlc: projectSdlcSettings.parse({ enabled: true }) },
      })
    ).projectId;
    expect(await errorCode(() => resolve("admin", [foreign]))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("items.projects.add", () => {
  const add = (who: string, id: string, projectId: string) =>
    as(who, (tx) => addItemProject(tx, org.user(who), { id, projectId }));

  it("quản trị tổ chức thêm dự án đội khác: audit và thông báo quản trị đội của dự án mới", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    await add("admin", item, p.c);
    expect((await itemProjects(item)).map((r) => r.projectId)).toEqual([p.a, p.b, p.c]);
    expect(await audits("sdlc.item.project_add", item)).toEqual([
      { projectId: p.c, projectKey: key("c"), teamId: teamC },
    ]);
    const { rows } = await admin.query(
      "select user_id from hive.inbox_items where org_id = $1 and event = 'sdlc.project_added'",
      [org.orgId],
    );
    const recipients = rows.map((r) => r.user_id as string);
    expect(recipients).toContain(org.user("cadmin"));
    // Người bấm không tự nhận thông báo; người ngoài các đội tham gia không nhận.
    expect(recipients).not.toContain(org.user("admin"));
    expect(recipients).not.toContain(org.user("loner"));
  });

  it("chủ hạng mục cần sdlc.write ở đội của dự án mới", async () => {
    const item = await seedItem("both", p.a, []);
    expect(await errorCode(() => add("both", item, p.c))).toBe("SDLC_FORBIDDEN");
    await add("both", item, p.b);
    expect((await itemProjects(item)).map((r) => r.projectId)).toEqual([p.a, p.b]);
  });

  it("thành viên không phải chủ, không quản trị đội chủ trì thì không đổi được", async () => {
    const item = await seedItem("both", p.a, []);
    expect(await errorCode(() => add("tmember", item, p.b))).toBe("SDLC_MANAGE_FORBIDDEN");
    // Người ngoài các đội tham gia: như không có hạng mục.
    expect(await errorCode(() => add("cadmin", item, p.c))).toBe("SDLC_ITEM_NOT_FOUND");
  });

  it("quản trị đội chủ trì thêm được dự án của đội mình", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    const own = await seedSdlcProject(`a2${n}`, org.teamId, org.systemId, { enabled: true });
    await add("tadmin", item, own);
    expect((await itemProjects(item)).map((r) => r.projectId)).toContain(own);
  });

  it("từ chối dự án đã tham gia, chưa bật AI SDLC, hạng mục đã đóng", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    expect(await errorCode(() => add("admin", item, p.b))).toBe("SDLC_PROJECT_ALREADY_ADDED");
    expect(await errorCode(() => add("admin", item, p.off))).toBe("SDLC_PROJECT_DISABLED");
    const done = await seedItem("both", p.a, [], "done");
    expect(await errorCode(() => add("admin", done, p.b))).toBe("SDLC_ITEM_CLOSED");
  });

  it("giới hạn 8 dự án mỗi hạng mục", async () => {
    const item = await seedItem("both", p.a, []);
    // Dòng giả cho đủ 8 dự án: giới hạn đếm dòng đang tham gia, không cần dự án thật.
    for (let i = 0; i < 7; i++)
      await admin.query(
        `insert into hive.sdlc_item_projects (org_id, item_id, project_id, team_id, role, settings, added_by)
         values ($1, $2, $3, $4, 'participant', '{}', 'seed')`,
        [org.orgId, item, randomUUID(), org.teamId],
      );
    expect(await errorCode(() => add("admin", item, p.b))).toBe("SDLC_TOO_MANY_PROJECTS");
  });
});

describe("items.projects.remove", () => {
  const remove = (who: string, id: string, projectId: string) =>
    as(who, (tx) => removeItemProject(tx, org.user(who), { id, projectId }));

  it("bỏ dự án chưa có task chạy: huỷ task todo, giữ task đã huỷ, đặt removed_at, audit", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    const todo = await seedTask(p.b, org.otherTeamId);
    const done = await seedTask(p.b, org.otherTeamId, "cancelled");
    const home = await seedTask(p.a, org.teamId);
    await linkTask(item, todo, p.b);
    await linkTask(item, done, p.b);
    await linkTask(item, home, p.a);
    const { cancelledTaskIds } = await remove("both", item, p.b);
    expect(cancelledTaskIds).toEqual([todo]);
    const statuses = await admin.query("select id, status from hive.tasks where id = any($1)", [[todo, done, home]]);
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({
      [todo]: "cancelled",
      [done]: "cancelled",
      [home]: "todo",
    });
    const removed = await admin.query("select task_id from hive.sdlc_item_tasks where item_id = $1 and removed", [
      item,
    ]);
    expect(removed.rows.map((r) => r.task_id).sort()).toEqual([todo, done].sort());
    expect((await itemProjects(item)).find((r) => r.projectId === p.b)?.removedAt).not.toBeNull();
    expect(await audits("sdlc.item.project_remove", item)).toEqual([
      { projectId: p.b, projectKey: key("b"), cancelledTaskIds: [todo] },
    ]);
  });

  it("dự án có task đã từng chạy (kể cả run thất bại, task về todo) thì không bỏ được", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    const task = await seedTask(p.b, org.otherTeamId);
    await linkTask(item, task, p.b);
    await seedRun(task, p.b, org.otherTeamId);
    const error = await as("both", (tx) => removeItemProject(tx, org.user("both"), { id: item, projectId: p.b })).catch(
      (e: unknown) => e as { code: string; message: string },
    );
    expect(error).toMatchObject({
      code: "SDLC_PROJECT_HAS_RUNS",
      message: `Dự án ${key("b")} đã có task chạy trong hạng mục; huỷ task trước.`,
    });
    expect((await itemProjects(item)).find((r) => r.projectId === p.b)?.removedAt).toBeNull();
  });

  it("không bỏ được dự án chính, dự án không tham gia, hay khi thiếu quyền ở dự án", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    expect(await errorCode(() => remove("both", item, p.a))).toBe("SDLC_HOME_PROJECT");
    expect(await errorCode(() => remove("both", item, p.c))).toBe("SDLC_ITEM_PROJECT_NOT_FOUND");
    // Quản trị đội chủ trì nhưng không có quyền ở đội của dự án bị bỏ.
    expect(await errorCode(() => remove("tadmin", item, p.b))).toBe("SDLC_FORBIDDEN");
  });

  it("thêm lại dự án đã bỏ thì dòng cũ hoạt động lại với cài đặt mới chụp", async () => {
    const item = await seedItem("both", p.a, [p.b]);
    await remove("both", item, p.b);
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{sdlc,maxParallel}', '5') where id = $1",
      [p.b],
    );
    try {
      await as("both", (tx) => addItemProject(tx, org.user("both"), { id: item, projectId: p.b }));
      const row = (await itemProjects(item)).find((r) => r.projectId === p.b);
      expect(row?.removedAt).toBeNull();
      expect(row?.settings.maxParallel).toBe(5);
    } finally {
      await admin.query(
        "update hive.projects set settings = jsonb_set(settings, '{sdlc,maxParallel}', '3') where id = $1",
        [p.b],
      );
    }
  });
});

describe("cổng theo đội (D21)", () => {
  const phases: ReviewPhase[] = [
    reviewPhase.parse({
      name: "Duyệt thiết kế",
      gates: [
        { id: "ai-check", name: "AI kiểm", kind: "ai", ai: { checks: ["Đủ mục"], passScore: 7 } },
        { id: "tech-lead", name: "Tech lead", kind: "human", reviewers: { roles: ["team-admin"] } },
        { id: "po", name: "PO", kind: "human", reviewers: { roles: ["team-ba"] } },
      ],
    }),
  ];

  it("itemTeams gộp dự án cùng đội, đội chủ trì trước", async () => {
    const item = await seedItem("both", p.a, [p.b, p.b2]);
    const teams = await as("both", (tx) => itemTeams(tx, item));
    expect(teams.map((t) => [t.teamId, t.projects.map((x) => x.key)])).toEqual([
      [org.teamId, [key("a")]],
      [org.otherTeamId, [key("b"), key("bb")]],
    ]);
  });

  it("nhân checkpoint trong perProjectGates thành một checkpoint mỗi đội, roles tính trong đội đó", async () => {
    const item = await seedItem("admin", p.a, [p.b, p.b2, p.c]);
    const [phase] = await as("admin", (tx) => perTeamWorkflow(tx, item, phases, ["tech-lead"]));
    expect(phase?.gates.map((g) => g.id)).toEqual([
      "ai-check",
      "tech-lead-thanh-toan",
      "tech-lead-crm",
      "tech-lead-mobile",
      "po",
    ]);
    const crm = phase?.gates.find((g) => g.id === "tech-lead-crm");
    expect(crm?.name).toBe(`Tech lead · crm (${key("b")}, ${key("bb")})`);
    expect(crm?.reviewers).toMatchObject({ roles: ["team-admin"], quorum: 1, teamScope: org.otherTeamId });
    // Checkpoint không nằm trong danh sách giữ nguyên, không có teamScope.
    expect(phase?.gates.find((g) => g.id === "po")?.reviewers?.teamScope).toBeUndefined();
    // Quy trình dựng ra vẫn hợp lệ với schema của spec 004.
    expect(reviewPhase.safeParse(phase).success).toBe(true);
  });

  it("hạng mục một đội giữ nguyên cổng", async () => {
    const item = await seedItem("both", p.a, []);
    const out = await as("both", (tx) => perTeamWorkflow(tx, item, phases, ["tech-lead"]));
    expect(out).toEqual(phases);
  });

  it("id checkpoint quá dài thì dùng số thứ tự đội", () => {
    const teams: ItemTeam[] = [
      { teamId: randomUUID(), slug: "a", name: "A", projects: [{ id: randomUUID(), key: "pa", name: "" }] },
      {
        teamId: randomUUID(),
        slug: "doi-co-ten-rat-dai-vuot-gioi-han",
        name: "Dài",
        projects: [{ id: randomUUID(), key: "pb", name: "" }],
      },
    ];
    const [phase] = expandPerProjectGates(phases, ["tech-lead"], teams);
    expect(phase?.gates.map((g) => g.id)).toEqual(["ai-check", "tech-lead-a", "tech-lead-2", "po"]);
  });
});
