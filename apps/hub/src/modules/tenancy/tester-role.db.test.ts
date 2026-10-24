import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import {
  allowWith,
  checkTeamRole,
  effectivePermissions,
  requireOrgRole,
  requireTeamRole,
  teamRoleOf,
} from "./index.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let orgId: string;
let teamId: string;
let user: (n: string) => string;
const tester = `tester-${randomUUID().slice(0, 8)}`;

const as = <T>(userId: string, run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId, userId }, run);

beforeAll(async () => {
  const org = await seedOrg(admin, `tester-role-${randomUUID().slice(0, 8)}`);
  ({ orgId, teamId, user } = org);
  await admin.query(`insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test')`, [tester]);
  // Tester là thành viên tổ chức như mọi người được mời vào đội, nên bị cộng quyền của vai trò tổ chức `member`.
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, tester]);
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'tester')", [
    teamId,
    orgId,
    tester,
  ]);
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe("tester bị từ chối mọi quyền cấm (FR-013, SC-007)", () => {
  // Mỗi dòng dựng lại đúng lệnh kiểm mà route gọi trước khi làm việc, cùng tham số; `control` là người route cho qua,
  // để chứng tỏ lệnh kiểm có cấp chứ không từ chối mọi người.
  const byRole: Array<[string, string, (tx: Tx, userId: string) => Promise<unknown>]> = [
    // tasks/tasks.ts createTask
    ["tasks.create", "tmember", async (tx, u) => checkTeamRole(await teamRoleOf(tx, u, teamId), "member")],
    // runs/engine.ts startRun → tasks/tasks.ts taskForUser(..., "member", "tasks.assign")
    [
      "runs.start",
      "tmember",
      (tx, u) =>
        allowWith(tx, u, "tasks.assign", async () => checkTeamRole(await teamRoleOf(tx, u, teamId), "member"), teamId),
    ],
    // runs/engine.ts cancelRun → runForUser → taskForUser(..., "member"), không xét vai trò tự tạo
    ["runs.cancel", "tmember", (tx, u) => requireTeamRole(tx, u, teamId, "member")],
    // codereview/decide.ts enqueueCodeReview
    [
      "merge.enqueue",
      "tmember",
      (tx, u) => allowWith(tx, u, "merge.enqueue", () => requireTeamRole(tx, u, teamId, "member"), teamId),
    ],
    // catalog/merge-queue.ts enqueueMergeAs → catalog/projects.ts projectFor(..., "member")
    ["merge-queue.enqueue", "tmember", (tx, u) => requireTeamRole(tx, u, teamId, "member")],
    // fleet/registration.ts createRegistration
    [
      "machines.register",
      "tadmin",
      (tx, u) => allowWith(tx, u, "machines.register", () => requireTeamRole(tx, u, teamId, "admin"), teamId),
    ],
    // fleet/machines.ts listMachines
    [
      "machines.read",
      "tadmin",
      (tx, u) => allowWith(tx, u, "machines.read", () => requireTeamRole(tx, u, teamId, "admin"), teamId),
    ],
    // tenancy/teams.ts thêm, đổi vai trò, gỡ thành viên đội
    [
      "teams.manage",
      "tadmin",
      (tx, u) => allowWith(tx, u, "teams.manage", () => requireTeamRole(tx, u, teamId, "admin"), teamId),
    ],
    // codereview/decide.ts requireOverride
    [
      "reviews.override",
      "tadmin",
      (tx, u) => allowWith(tx, u, "reviews.override", () => requireTeamRole(tx, u, teamId, "admin"), teamId),
    ],
  ];

  it.each(byRole)("%s", async (_name, control, run) => {
    expect(await as(user(control), (tx) => run(tx, user(control)))).toBeTruthy();
    expect(await errorCode(() => as(tester, (tx) => run(tx, tester)))).toBe("TEAM_ROLE_REQUIRED");
  });

  it("members.invite: mời ở cấp tổ chức, vai trò đội không cộng vào", async () => {
    // tenancy/invitations.ts tạo, gửi lại, thu hồi lời mời
    const run = (u: string) => as(u, (tx) => allowWith(tx, u, "members.invite", () => requireOrgRole(tx, u, "admin")));
    expect(await run(user("admin"))).toBe("admin");
    expect(await errorCode(() => run(tester))).toBe("ORG_ROLE_REQUIRED");
  });

  // Các route này hỏi thẳng `effectivePermissions` ở đội sở hữu: delivery/ci/feed.ts ciProject (chạy lại, huỷ CI),
  // delivery/approvals.ts approverCheck, delivery/deploys/orchestrator.ts requireDeployRun, delivery/servers.ts
  // requireManage, terminal/access.ts canOpenTerminal, sdlc/overrides.ts requireOverridePermission.
  it.each(["ci.operate", "deploy.approve", "deploy.run", "servers.manage", "leader.terminal", "sdlc.override"])(
    "%s",
    async (permission) => {
      const granted = (u: string) => as(u, async (tx) => (await effectivePermissions(tx, u, teamId)).has(permission));
      expect(await granted(user("tadmin"))).toBe(true);
      expect(await granted(tester)).toBe(false);
    },
  );
});
