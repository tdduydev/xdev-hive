import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { qaError, qaProject } from "./access.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let orgId: string;
let projectId: string;
let user: (n: string) => string;
let tester: string;

const as = <T>(userId: string, run: Parameters<typeof withTenant<T>>[2]) => withTenant(app, { orgId, userId }, run);
const check = (
  userId: string,
  ...args: Parameters<typeof qaProject> extends [unknown, unknown, ...infer R] ? R : never
) => as(userId, (tx) => qaProject(tx, userId, ...args));

beforeAll(async () => {
  const org = await seedOrg(admin, `qa-access-${randomUUID().slice(0, 8)}`);
  ({ orgId, user } = org);
  tester = `tester-${randomUUID().slice(0, 8)}`;
  await admin.query(`insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test')`, [tester]);
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, tester]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'tester')", [
    org.teamId,
    orgId,
    tester,
  ]);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, orgId, user("owner")],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [orgId, org.teamId, org.systemId, scm, randomUUID(), user("owner")],
    )
  ).rows[0].id as string;
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe("qaProject (FR-015, FR-016)", () => {
  it("dự án không có hoặc ngoài đội báo như không tồn tại", async () => {
    expect(await errorCode(() => check(user("tadmin"), randomUUID(), "qa.read"))).toBe("PROJECT_NOT_FOUND");
    for (const n of ["oadmin", "loner"])
      expect(await errorCode(() => check(user(n), projectId, "qa.read")), n).toBe("PROJECT_NOT_FOUND");
  });

  it("thư viện chưa bật thì chỉ route projectSettings qua được", async () => {
    expect(await errorCode(() => check(user("tviewer"), projectId, "qa.read"))).toBe("QA_LIBRARY_DISABLED");
    const off = await check(user("tviewer"), "billing", ["qa.read", "projects.settings"], { allowDisabled: true });
    expect(off.project.id).toBe(projectId);
    expect(off.settings).toEqual({ enabled: false, tcDir: "test-cases/", includeResult: null });
  });

  describe("đã bật thư viện", () => {
    beforeAll(async () => {
      await admin.query(
        "insert into hive.qa_project_settings (project_id, org_id, enabled, tc_dir, include_result) values ($1, $2, true, 'qa/', 'added')",
        [projectId, orgId],
      );
    });

    it("trả cài đặt và quyền của người gọi, nhận cả key", async () => {
      const got = await check(user("tviewer"), "billing", "qa.read");
      expect(got.settings).toEqual({ enabled: true, tcDir: "qa/", includeResult: "added" });
      expect(got.permissions.has("qa.cases.write")).toBe(false);
    });

    it("thiếu quyền thì nêu quyền còn thiếu", async () => {
      const denied = await check(user("tviewer"), projectId, "qa.cases.write").catch(
        (e: Error & { code: string }) => e,
      );
      expect(denied).toMatchObject({
        code: "QA_PERMISSION_REQUIRED",
        message: "Cần quyền `qa.cases.write` ở đội của dự án này.",
      });
      const anyOf = await check(user("tmember"), projectId, ["qa.cases.write", "qa.rounds.manage"]).catch(
        (e: Error) => e,
      );
      expect(anyOf).toMatchObject({
        message: "Cần quyền `qa.cases.write` hoặc `qa.rounds.manage` ở đội của dự án này.",
      });
    });

    it("tester quản lý được kiểm thử nhưng không sửa cài đặt dự án", async () => {
      expect((await check(tester, projectId, "qa.cases.write")).project.key).toBe("billing");
      expect(await errorCode(() => check(tester, projectId, "projects.settings"))).toBe("QA_PERMISSION_REQUIRED");
    });

    it("admin tổ chức là admin mọi đội", async () => {
      for (const n of ["admin", "tadmin"])
        expect((await check(user(n), projectId, "projects.settings")).permissions.has("qa.rounds.manage"), n).toBe(
          true,
        );
    });
  });
});

describe("qaError", () => {
  it("lấy trạng thái và thông điệp từ QA_ERRORS", () => {
    expect(qaError("QA_SOURCE_LABEL_TAKEN", { nhãn: "e2e" })).toMatchObject({
      code: "QA_SOURCE_LABEL_TAKEN",
      name: "ConflictError",
      message: "Dự án đã có nguồn tên `e2e`.",
    });
    expect(qaError("QA_ROUND_EMPTY")).toMatchObject({ name: "BadRequestError" });
    expect(qaError("QA_NOT_ASSIGNED")).toMatchObject({ name: "ForbiddenError" });
  });
});
