// projectMembers: thêm, gỡ, xem thành viên dự án; quyền theo đội sở hữu; "mine" cho bộ lọc "Dự án của tôi".
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  addCreatorAsMember,
  addProjectMembers,
  listProjectMembers,
  myProjectMembership,
  removeProjectMember,
} from "./members.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;

beforeAll(async () => {
  org = await seedOrg(admin, `pm-${tag}`);
  other = await seedOrg(admin, `pm-o-${tag}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

let seq = 0;
async function newProject(): Promise<string> {
  seq += 1;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `pm${seq}-${tag}`,
  });
  return p.projectId;
}

const as = <T>(who: string, fn: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => fn(tx, org.user(who)));
const add = (who: string, projectId: string, userIds: string[]) =>
  as(who, (tx, me) => addProjectMembers(tx, me, projectId, userIds));
const list = (who: string, projectId: string) => as(who, (tx, me) => listProjectMembers(tx, me, projectId));
const auditCount = async (projectId: string, action: string) =>
  (
    await admin.query("select count(*)::int as n from hive.audit_log where target_id = $1 and action = $2", [
      projectId,
      action,
    ])
  ).rows[0].n as number;

describe("thành viên dự án", () => {
  it("admin đội thêm thành viên đội vào dự án và ghi audit", async () => {
    const p = await newProject();
    const members = await add("tadmin", p, [org.user("tmember")]);
    expect(members).toEqual([
      expect.objectContaining({
        userId: org.user("tmember"),
        name: org.user("tmember"),
        email: `${org.user("tmember")}@seed.test`,
        addedBy: org.user("tadmin"),
      }),
    ]);
    expect(new Date(members[0]?.addedAt ?? "").getTime()).not.toBeNaN();
    const { rows } = await admin.query(
      "select actor_user_id, data from hive.audit_log where target_id = $1 and action = 'project_member.add'",
      [p],
    );
    expect(rows).toEqual([{ actor_user_id: org.user("tadmin"), data: { userId: org.user("tmember") } }]);
  });

  it("thêm lại người đã là thành viên không lỗi, không trùng", async () => {
    const p = await newProject();
    await add("tadmin", p, [org.user("tmember")]);
    await add("tadmin", p, [org.user("tmember"), org.user("tmember")]);
    expect(await list("tadmin", p)).toHaveLength(1);
    expect(await auditCount(p, "project_member.add")).toBe(1);
  });

  it("từ chối cả lô khi có người ngoài đội", async () => {
    const p = await newProject();
    expect(await errorCode(() => add("tadmin", p, [org.user("tmember"), org.user("loner")]))).toBe(
      "PROJECT_MEMBER_NOT_IN_TEAM",
    );
    expect(await list("tadmin", p)).toEqual([]);
    expect(await errorCode(() => add("tadmin", p, [other.user("tmember")]))).toBe("PROJECT_MEMBER_NOT_IN_TEAM");
    expect(await list("tadmin", p)).toEqual([]);
    expect(await auditCount(p, "project_member.add")).toBe(0);
  });

  it("thành viên thường và viewer chỉ xem được", async () => {
    const p = await newProject();
    await add("tadmin", p, [org.user("tmember")]);
    expect(await list("tviewer", p)).toHaveLength(1);
    expect(await errorCode(() => add("tmember", p, [org.user("tviewer")]))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => as("tviewer", (tx, me) => removeProjectMember(tx, me, p, org.user("tmember"))))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    expect(await errorCode(() => list("loner", p))).toBe("PROJECT_NOT_FOUND");
  });

  it("vai trò tự tạo projects.settings của đội được thêm", async () => {
    const p = await newProject();
    const role = (
      await admin.query(
        "insert into hive.custom_roles (org_id, name, scope, permissions, created_by) values ($1, $2, 'team', $3, 'seed') returning id",
        [org.orgId, `pm-${tag}`, ["projects.settings"]],
      )
    ).rows[0].id as string;
    await admin.query("insert into hive.team_custom_roles (org_id, team_id, role_id) values ($1, $2, $3)", [
      org.orgId,
      org.teamId,
      role,
    ]);
    try {
      expect(await add("tmember", p, [org.user("tviewer")])).toHaveLength(1);
    } finally {
      await admin.query("delete from hive.team_custom_roles where role_id = $1", [role]);
      await admin.query("delete from hive.custom_roles where id = $1", [role]);
    }
  });

  it("admin đội khác không quản lý được dự án đội này", async () => {
    // oadmin là quản trị của otherTeamId, không có vai trò ở đội sở hữu dự án.
    const p = await newProject();
    expect(await errorCode(() => add("oadmin", p, [org.user("tmember")]))).toBe("PROJECT_NOT_FOUND");
    expect(await errorCode(() => list("oadmin", p))).toBe("PROJECT_NOT_FOUND");
  });

  it("gỡ thành viên và ghi audit; gỡ người không phải thành viên báo PROJECT_MEMBER_NOT_FOUND", async () => {
    const p = await newProject();
    await add("tadmin", p, [org.user("tmember"), org.user("tviewer")]);
    expect(await as("tadmin", (tx, me) => removeProjectMember(tx, me, p, org.user("tmember")))).toEqual({ ok: true });
    expect((await list("tadmin", p)).map((m) => m.userId)).toEqual([org.user("tviewer")]);
    expect(await auditCount(p, "project_member.remove")).toBe(1);
    expect(await errorCode(() => as("tadmin", (tx, me) => removeProjectMember(tx, me, p, org.user("tmember"))))).toBe(
      "PROJECT_MEMBER_NOT_FOUND",
    );
  });

  it("mine trả dự án mình tham gia và đội mình là thành viên trực tiếp", async () => {
    // tmember có thể đã ở dự án của test khác trong file, nên dùng một dự án riêng và so phần chứa.
    const p = await newProject();
    await add("tadmin", p, [org.user("tmember")]);
    const mine = await as("tmember", (tx, me) => myProjectMembership(tx, me));
    expect(mine.projectIds).toContain(p);
    expect(mine.teamIds).toEqual([org.teamId]);
    expect(await as("owner", (tx, me) => myProjectMembership(tx, me))).toEqual({ projectIds: [], teamIds: [] });
  });

  it("tạo dự án thêm người tạo làm thành viên khi người tạo thuộc đội", async () => {
    const p = await newProject();
    await as("tadmin", (tx, me) => addCreatorAsMember(tx, { id: p, teamId: org.teamId }, me));
    await as("owner", (tx, me) => addCreatorAsMember(tx, { id: p, teamId: org.teamId }, me));
    expect(await list("tadmin", p)).toEqual([
      expect.objectContaining({ userId: org.user("tadmin"), addedBy: org.user("tadmin") }),
    ]);
  });
});
