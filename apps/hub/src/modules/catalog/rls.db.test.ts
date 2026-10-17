import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { projectMembers } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";

type Org = OrgFixture & { user: (n: string) => string };
let orgA: Org;
let orgB: Org;
let projectA = "";
let projectB = "";

const addMember = (org: Org, projectId: string, n: string) =>
  admin.query(
    "insert into hive.project_members (project_id, org_id, team_id, user_id, added_by) values ($1, $2, $3, $4, $4)",
    [projectId, org.orgId, org.teamId, org.user(n)],
  );

beforeAll(async () => {
  orgA = await seedOrg(admin, `pma-${tag}`);
  orgB = await seedOrg(admin, `pmb-${tag}`);
  const project = async (org: Org, key: string) =>
    (
      await seedProject(admin, app, {
        orgId: org.orgId,
        teamId: org.teamId,
        systemId: org.systemId,
        adminUserId: org.user("admin"),
        masterKey,
        key,
      })
    ).projectId;
  projectA = await project(orgA, `pma-${tag}`);
  projectB = await project(orgB, `pmb-${tag}`);
  await addMember(orgA, projectA, "tmember");
  await addMember(orgB, projectB, "tmember");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("RLS của project_members", () => {
  it("không có context thì project_members trả 0 dòng", async () => {
    const rows = await withTenant(app, {}, (tx) => tx.select().from(projectMembers));
    expect(rows).toHaveLength(0);
  });

  it("context tổ chức A chỉ thấy thành viên dự án của A", async () => {
    const rows = await withTenant(app, { userId: orgA.user("tmember"), orgId: orgA.orgId }, (tx) =>
      tx.select().from(projectMembers),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.orgId).toBe(orgA.orgId);
  });

  it("không ghi được thành viên dự án vào tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: orgA.user("tadmin"), orgId: orgA.orgId }, (tx) =>
        tx.insert(projectMembers).values({
          projectId: projectB,
          orgId: orgB.orgId,
          teamId: orgB.teamId,
          userId: orgB.user("tadmin"),
          addedBy: orgA.user("tadmin"),
        }),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });
});

describe("khoá ngoại của project_members", () => {
  it("khoá ngoại chặn người không thuộc đội", async () => {
    expect(await pgCode(() => addMember(orgA, projectA, "loner"))).toBe(FK_VIOLATION);
  });

  it("gỡ khỏi đội thì mất thành viên dự án", async () => {
    await addMember(orgA, projectA, "tviewer");
    await admin.query("delete from hive.team_members where team_id = $1 and user_id = $2", [
      orgA.teamId,
      orgA.user("tviewer"),
    ]);
    const { rows } = await admin.query("select 1 from hive.project_members where project_id = $1 and user_id = $2", [
      projectA,
      orgA.user("tviewer"),
    ]);
    expect(rows).toHaveLength(0);
  });
});
