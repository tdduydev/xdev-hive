import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, withTenant } from "../platform/index.ts";
import { machines, machineTokens, registrationTokens } from "./schema.ts";
import { withTokenLookup } from "./tokens.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
const tag = randomUUID().slice(0, 8);
const ids = { teamA: "", teamB: "", machineA: "", machineB: "" };

beforeAll(async () => {
  // Seed bằng superuser (bỏ qua RLS) để test đứng độc lập với code đăng ký.
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1, $3, 'A', 'u'), ($2, $4, 'B', 'u')",
    [orgA, orgB, `rls-a-${tag}`, `rls-b-${tag}`],
  );
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;
  ids.teamA = await one("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgA]);
  ids.teamB = await one("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgB]);
  const machine =
    "insert into hive.machines (org_id, team_id, name, os, version) values ($1, $2, 'm', 'linux', '1') returning id";
  ids.machineA = await one(machine, [orgA, ids.teamA]);
  ids.machineB = await one(machine, [orgB, ids.teamB]);
  await admin.query(
    `insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values
       ($1, $2, $3, $7), ($4, $5, $6, $8)`,
    [orgA, ids.teamA, ids.machineA, orgB, ids.teamB, ids.machineB, `mt-a-${tag}`, `mt-b-${tag}`],
  );
  await admin.query(
    `insert into hive.registration_tokens (org_id, team_id, token_hash, expires_at, created_by) values
       ($1, $2, $5, now() + interval '1 hour', 'u'), ($3, $4, $6, now() + interval '1 hour', 'u')`,
    [orgA, ids.teamA, orgB, ids.teamB, `rt-a-${tag}`, `rt-b-${tag}`],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}
const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";
const tables = [machines, machineTokens, registrationTokens];

describe("RLS bảng fleet", () => {
  it("không có context thì cả ba bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A", async () => {
    await withTenant(app, { orgId: orgA }, async (tx) => {
      for (const t of tables) {
        const rows = await tx.select().from(t);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.orgId === orgA)).toBe(true);
      }
    });
  });

  it("không ghi được máy cho tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machines).values({ orgId: orgB, teamId: ids.teamB, name: "x", os: "linux", version: "1" }),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("UPDATE không chuyển được máy sang tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.update(machines).set({ orgId: orgB }).where(eq(machines.id, ids.machineA)),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("máy không trỏ được tới đội của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machines).values({ orgId: orgA, teamId: ids.teamB, name: "y", os: "linux", version: "1" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });

  it("machine token không trỏ được tới máy của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machineTokens).values({ orgId: orgA, teamId: ids.teamA, machineId: ids.machineB, tokenHash: "z" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });
});

describe("tìm theo băm token khi chưa có tổ chức", () => {
  it("chỉ thấy đúng dòng có băm đó, ở đúng bảng có băm đó", async () => {
    await withTokenLookup(app, `mt-a-${tag}`, async (tx) => {
      expect((await tx.select().from(machineTokens)).map((r) => r.machineId)).toEqual([ids.machineA]);
      expect(await tx.select().from(registrationTokens)).toHaveLength(0);
      expect(await tx.select().from(machines)).toHaveLength(0);
    });
    await withTokenLookup(app, `rt-b-${tag}`, async (tx) => {
      expect((await tx.select().from(registrationTokens)).map((r) => r.orgId)).toEqual([orgB]);
    });
  });

  it("băm sai thì không thấy gì", async () => {
    await withTokenLookup(app, "khong-co", async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("biết băm cũng không sửa hay xoá được dòng", async () => {
    await withTokenLookup(app, `rt-a-${tag}`, async (tx) => {
      expect(await tx.update(registrationTokens).set({ usedAt: new Date() }).returning()).toHaveLength(0);
      expect(await tx.delete(registrationTokens).returning()).toHaveLength(0);
    });
    const { rows } = await admin.query("select used_at from hive.registration_tokens where token_hash = $1", [
      `rt-a-${tag}`,
    ]);
    expect(rows[0].used_at).toBeNull();
  });

  it("app.fleet_token_hash không rò sang lần mượn kết nối sau", async () => {
    await withTokenLookup(app, `mt-a-${tag}`, async () => {});
    const client = await app.connect();
    try {
      const { rows } = await client.query("select hive.ctx_fleet_token() as t");
      expect(rows[0]).toEqual({ t: null });
    } finally {
      client.release();
    }
  });
});
