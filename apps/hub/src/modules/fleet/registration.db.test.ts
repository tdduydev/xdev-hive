import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, ForbiddenError, withTenant } from "../platform/index.ts";
import { FleetError } from "./errors.ts";
import {
  authenticateMachine,
  listMachines,
  listOnlineMachines,
  pauseMachine,
  requestMachineUpdate,
  resumeMachine,
  revokeMachine,
} from "./machines.ts";
import { createRegistration, registerMachine } from "./registration.ts";
import { hashToken } from "./tokens.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
let teamA = "";
let teamA2 = "";
const tag = randomUUID().slice(0, 8);
const user = (name: string) => `${name}-${tag}`;

beforeAll(async () => {
  // Có thể có khoá ngoại tới auth."user" (M1c), nên tạo người dùng trước.
  await admin.query(
    `insert into auth."user" (id, name, email) select id, id, id || '@seed.test' from unnest($1::text[]) as id
     on conflict (id) do nothing`,
    [[user("admin"), user("member")]],
  );
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'A', $3)", [
    orgA,
    `fleet-${tag}`,
    user("admin"),
  ]);
  await admin.query(
    "insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')",
    [orgA, user("admin"), user("member")],
  );
  const team = async (slug: string) =>
    (await admin.query("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [orgA, slug]))
      .rows[0].id as string;
  teamA = await team("ta");
  teamA2 = await team("ta2");
  await admin.query(
    `insert into hive.team_members (team_id, org_id, user_id, role) values
       ($1, $3, $4, 'admin'), ($2, $3, $4, 'admin'), ($1, $3, $5, 'member')`,
    [teamA, teamA2, orgA, user("admin"), user("member")],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const newRegistration = (teamId = teamA, userId = user("admin")) =>
  withTenant(app, { userId, orgId: orgA }, (tx) => createRegistration(tx, userId, teamId));

const register = (registrationToken: string, machineId: string) =>
  registerMachine(app, { registrationToken, machineId, os: "linux", version: "0.1.0", clis: ["claude"], capacity: 2 });

async function fleetCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof FleetError || error instanceof ForbiddenError) return error.code;
    throw error;
  }
}

describe("tạo mã đăng ký", () => {
  it("admin đội nhận mã một lần, database chỉ giữ băm, hết hạn sau 1 giờ", async () => {
    const before = Date.now();
    const { token, expiresAt } = await newRegistration();
    expect(token).toMatch(/^hwr_[A-Za-z0-9_-]{43}$/);
    const ttl = expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    const { rows } = await admin.query("select token_hash from hive.registration_tokens where token_hash = $1", [
      hashToken(token),
    ]);
    expect(rows).toHaveLength(1);
    const plain = await admin.query("select count(*)::int as n from hive.registration_tokens where token_hash = $1", [
      token,
    ]);
    expect(plain.rows[0].n).toBe(0);
  });

  it("thành viên thường của đội không tạo được", async () => {
    expect(await fleetCode(() => newRegistration(teamA, user("member")))).toBe("TEAM_ROLE_REQUIRED");
  });

  it("ghi audit", async () => {
    await newRegistration();
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.audit_log where org_id = $1 and action = 'machine.registration.create'",
      [orgA],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe("đăng ký máy", () => {
  it("đổi mã lấy machine token; token xác thực được máy", async () => {
    const { token } = await newRegistration();
    const out = await register(token, `may-${tag}`);
    expect(out).toMatchObject({ orgId: orgA, teamId: teamA, machineId: `may-${tag}` });
    expect(out.machineToken).toMatch(/^hwm_/);
    expect(await authenticateMachine(app, out.machineToken)).toEqual({
      id: out.id,
      orgId: orgA,
      teamId: teamA,
      name: `may-${tag}`,
      kind: "worker",
    });
    const { rows } = await admin.query(
      "select status, os, clis, capacity, registered_by from hive.machines where id = $1",
      [out.id],
    );
    expect(rows[0]).toEqual({
      status: "offline",
      os: "linux",
      clis: ["claude"],
      capacity: 2,
      registered_by: user("admin"),
    });
    const audit = await admin.query(
      "select actor_user_id from hive.audit_log where action = 'machine.register' and target_id = $1",
      [out.id],
    );
    expect(audit.rows).toEqual([{ actor_user_id: null }]);
  });

  it("mã sai bị từ chối", async () => {
    expect(await fleetCode(() => register("hwr_khong-ton-tai", `sai-${tag}`))).toBe("REGISTRATION_INVALID");
    expect(await fleetCode(() => register("khong-co-tien-to", `sai-${tag}`))).toBe("REGISTRATION_INVALID");
  });

  it("mã hết hạn bị từ chối", async () => {
    const { token } = await newRegistration();
    await admin.query(
      "update hive.registration_tokens set expires_at = now() - interval '1 second' where token_hash = $1",
      [hashToken(token)],
    );
    expect(await fleetCode(() => register(token, `het-han-${tag}`))).toBe("REGISTRATION_INVALID");
    const { rows } = await admin.query("select count(*)::int as n from hive.machines where name = $1", [
      `het-han-${tag}`,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("mã chỉ dùng được một lần, kể cả khi gửi cùng lúc", async () => {
    const { token } = await newRegistration();
    const results = await Promise.allSettled([register(token, `mot-lan-${tag}`), register(token, `mot-lan-2-${tag}`)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await fleetCode(() => register(token, `mot-lan-3-${tag}`))).toBe("REGISTRATION_INVALID");
  });

  it("tên máy đã thuộc đội khác thì báo xung đột và không tiêu mã", async () => {
    const first = await newRegistration(teamA);
    await register(first.token, `trung-${tag}`);
    const other = await newRegistration(teamA2);
    expect(await fleetCode(() => register(other.token, `trung-${tag}`))).toBe("MACHINE_NAME_TAKEN");
    // Mã vẫn dùng được với tên khác vì transaction đã rollback.
    await expect(register(other.token, `khac-${tag}`)).resolves.toMatchObject({ teamId: teamA2 });
  });

  it("cài lại máy cùng tên trong cùng đội: giữ id, token cũ hết hiệu lực", async () => {
    const a = await register((await newRegistration()).token, `cai-lai-${tag}`);
    const b = await register((await newRegistration()).token, `cai-lai-${tag}`);
    expect(b.id).toBe(a.id);
    expect(await authenticateMachine(app, a.machineToken)).toBeNull();
    expect(await authenticateMachine(app, b.machineToken)).not.toBeNull();
  });
});

describe("danh sách và thu hồi", () => {
  it("admin đội xem được máy của đội; thành viên thường thì không", async () => {
    const mine = await register((await newRegistration()).token, `ds-${tag}`);
    await admin.query("update hive.machines set bound_projects = $2, full_projects = $3 where id = $1", [
      mine.id,
      ["p-bound", "p-full"],
      ["p-full"],
    ]);
    const list = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      listMachines(tx, user("admin"), teamA),
    );
    expect(list.map((m) => m.name)).toContain(`ds-${tag}`);
    // Dự án gắn repo local và dự án bật toàn quyền (ADR 0020) đi kèm để web hiện cho quản trị đội.
    const listed = list.find((m) => m.id === mine.id);
    expect(listed?.boundProjects).toEqual(["p-bound", "p-full"]);
    expect(listed?.fullProjects).toEqual(["p-full"]);
    expect(list.every((m) => m.teamId === teamA)).toBe(true);
    expect(
      await fleetCode(() =>
        withTenant(app, { userId: user("member"), orgId: orgA }, (tx) => listMachines(tx, user("member"), teamA)),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
  });

  it("thu hồi làm machine token hết hiệu lực và ghi audit", async () => {
    const out = await register((await newRegistration()).token, `thu-hoi-${tag}`);
    const m = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      revokeMachine(tx, user("admin"), out.id),
    );
    expect(m.status).toBe("revoked");
    expect(await authenticateMachine(app, out.machineToken)).toBeNull();
    const { rows } = await admin.query("select count(*)::int as n from hive.machine_tokens where machine_id = $1", [
      out.id,
    ]);
    expect(rows[0].n).toBe(0);
    const audit = await admin.query(
      "select actor_user_id from hive.audit_log where action = 'machine.revoke' and target_id = $1",
      [out.id],
    );
    expect(audit.rows).toEqual([{ actor_user_id: user("admin") }]);
  });

  it("thu hồi máy không có thì báo không tìm thấy", async () => {
    expect(
      await fleetCode(() =>
        withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) => revokeMachine(tx, user("admin"), randomUUID())),
      ),
    ).toBe("MACHINE_NOT_FOUND");
  });
});

describe("tạm dừng máy", () => {
  it("không giao run mới, giữ kết nối và ghi audit khi tạm dừng/chạy lại", async () => {
    const machine = await register((await newRegistration()).token, `pause-${tag}`);
    await admin.query("update hive.machines set status = 'online' where id = $1", [machine.id]);
    const pause = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      pauseMachine(tx, user("admin"), machine.id),
    );
    expect(pause.status).toBe("paused");
    expect(
      (
        await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) => listMachines(tx, user("admin"), teamA))
      ).find((row) => row.id === machine.id)?.status,
    ).toBe("paused");
    expect(await withTenant(app, { orgId: orgA }, (tx) => listOnlineMachines(tx, teamA))).not.toContainEqual(
      expect.objectContaining({ id: machine.id }),
    );
    const resumed = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      resumeMachine(tx, user("admin"), machine.id),
    );
    expect(resumed.status).toBe("online");
    const { rows } = await admin.query(
      "select action from hive.audit_log where org_id = $1 and target_id = $2 and action in ('machine.pause', 'machine.resume') order by created_at",
      [orgA, machine.id],
    );
    expect(rows.map((row) => row.action)).toEqual(["machine.pause", "machine.resume"]);
  });
});

describe("yêu cầu cập nhật worker", () => {
  const asUser = (name: string, machineId: string, version?: string) =>
    withTenant(app, { userId: user(name), orgId: orgA }, (tx) =>
      requestMachineUpdate(tx, user(name), machineId, version),
    );

  it("admin đội gửi được cho máy online và có audit; thành viên thường thì không", async () => {
    const machine = await register((await newRegistration()).token, `update-${tag}`);
    await admin.query("update hive.machines set status = 'online' where id = $1", [machine.id]);
    expect(await fleetCode(() => asUser("member", machine.id))).toBe("TEAM_ROLE_REQUIRED");
    const m = await asUser("admin", machine.id, "0.2.0");
    expect(m).toMatchObject({ id: machine.id, version: "0.1.0" });
    const { rows } = await admin.query(
      "select actor_user_id, data from hive.audit_log where action = 'machine.update' and target_id = $1",
      [machine.id],
    );
    expect(rows).toEqual([
      { actor_user_id: user("admin"), data: { name: `update-${tag}`, teamId: teamA, from: "0.1.0", to: "0.2.0" } },
    ]);
  });

  it("máy mất kết nối hoặc đã thu hồi thì báo xung đột, không ghi audit", async () => {
    const machine = await register((await newRegistration()).token, `update-off-${tag}`);
    expect(await fleetCode(() => asUser("admin", machine.id))).toBe("MACHINE_OFFLINE");
    await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) => revokeMachine(tx, user("admin"), machine.id));
    expect(await fleetCode(() => asUser("admin", machine.id))).toBe("MACHINE_REVOKED");
    const { rows } = await admin.query(
      "select count(*)::int as n from hive.audit_log where action = 'machine.update' and target_id = $1",
      [machine.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

it("assigns host type from the admin registration token and prevents converting a worker", async () => {
  const createHostRegistration = () =>
    withTenant(app, { orgId: orgA, userId: user("admin") }, (tx) =>
      createRegistration(tx, user("admin"), teamA, "host"),
    );
  const { token } = await createHostRegistration();
  const host = await register(token, `host-${tag}`);
  const listed = await withTenant(app, { orgId: orgA, userId: user("admin") }, (tx) =>
    listMachines(tx, user("admin"), teamA),
  );
  expect(listed.find((m) => m.id === host.id)?.kind).toBe("host");
  const workerToken = await newRegistration();
  const worker = await register(workerToken.token, `dev-${tag}`);
  const conversionToken = await createHostRegistration();
  expect(await fleetCode(() => register(conversionToken.token, `dev-${tag}`))).toBe("MACHINE_NAME_TAKEN");
  expect((await admin.query("select kind from hive.machines where id = $1", [worker.id])).rows[0].kind).toBe("worker");
});
