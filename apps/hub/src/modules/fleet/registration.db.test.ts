import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, ForbiddenError, withTenant } from "../platform/index.ts";
import { FleetError } from "./errors.ts";
import { authenticateMachine, listMachines, revokeMachine } from "./machines.ts";
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
    await register((await newRegistration()).token, `ds-${tag}`);
    const list = await withTenant(app, { userId: user("admin"), orgId: orgA }, (tx) =>
      listMachines(tx, user("admin"), teamA),
    );
    expect(list.map((m) => m.name)).toContain(`ds-${tag}`);
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
