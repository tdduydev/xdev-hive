import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createConnection, listConnections, loadConnection, removeConnection } from "./connections.ts";
import { createMemoryProvider } from "./memory.ts";
import { checkConnection } from "./router.ts";
import { scmConnections } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const master = parseMasterKey(randomBytes(32).toString("base64"));

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>, orgId = org.orgId) =>
  withTenant(app, { userId: org.user(who), orgId }, fn);

const gitlabInput = (name: string) =>
  ({
    kind: "gitlab",
    name,
    baseUrl: "https://gitlab.example.com",
    defaultOwner: "thanh-toan",
    token: "glpat-bi-mat-123",
  }) as const;

beforeAll(async () => {
  org = await seedOrg(admin, "scm");
  other = await seedOrg(admin, "scm2");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("scm_connections: phân quyền", () => {
  it.each(["tadmin", "tmember", "loner"])("%s (không quản trị tổ chức) không tạo được", async (who) => {
    expect(
      await errorCode(() => as(who, (tx) => createConnection(tx, master, org.user(who), gitlabInput(`x-${who}`)))),
    ).toBe("ORG_ROLE_REQUIRED");
  });

  it("quản trị tổ chức tạo được, ghi audit không kèm secret", async () => {
    const conn = await as("admin", (tx) =>
      createConnection(tx, master, org.user("admin"), gitlabInput("GitLab nội bộ")),
    );
    expect(conn).toMatchObject({ kind: "gitlab", name: "GitLab nội bộ", baseUrl: "https://gitlab.example.com" });
    const audit = await admin.query("select data from hive.audit_log where target_id = $1", [conn.id]);
    expect(JSON.stringify(audit.rows)).not.toContain("glpat");
  });

  it("trùng tên trong tổ chức thì CONFLICT", async () => {
    await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("trung-ten")));
    expect(
      await errorCode(() =>
        as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("trung-ten"))),
      ),
    ).toBe("SCM_CONNECTION_NAME_TAKEN");
  });
});

describe("scm_connections: secret", () => {
  it("lưu bản mã, không lưu token gốc; đọc lại giải mã đúng", async () => {
    const conn = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("ma-hoa")));
    const raw = await admin.query("select secret_enc from hive.scm_connections where id = $1", [conn.id]);
    expect(raw.rows[0].secret_enc).not.toContain("glpat");
    const loaded = await as("tmember", (tx) => loadConnection(tx, master, conn.id));
    expect(loaded?.secret).toEqual({ token: "glpat-bi-mat-123" });
  });

  it("chép bản mã sang dòng khác thì không giải mã được", async () => {
    const a = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("chep-a")));
    const b = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("chep-b")));
    await admin.query(
      "update hive.scm_connections set secret_enc = (select secret_enc from hive.scm_connections where id = $1) where id = $2",
      [a.id, b.id],
    );
    await expect(as("owner", (tx) => loadConnection(tx, master, b.id))).rejects.toThrow(/giải mã/);
  });
});

describe("scm_connections: RLS", () => {
  it("không có context thì 0 dòng", async () => {
    await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("rls")));
    const rows = await withTenant(app, {}, (tx) => tx.select().from(scmConnections));
    expect(rows).toHaveLength(0);
  });

  it("tổ chức khác không thấy kết nối", async () => {
    const mine = await as("owner", (tx) => listConnections(tx));
    expect(mine.length).toBeGreaterThan(0);
    const theirs = await withTenant(app, { userId: other.user("owner"), orgId: other.orgId }, (tx) =>
      listConnections(tx),
    );
    expect(theirs.map((c) => c.id)).not.toEqual(expect.arrayContaining(mine.map((c) => c.id)));
  });

  it("không ghi được kết nối vào tổ chức khác", async () => {
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx.insert(scmConnections).values({
          orgId: other.orgId,
          kind: "gitlab",
          name: "lan",
          secretEnc: "x",
          createdBy: "x",
        }),
      ),
    );
    expect(code).toBe("42501");
  });

  it("UPDATE không chuyển được kết nối sang tổ chức khác", async () => {
    const conn = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("chuyen")));
    const code = await pgCode(() =>
      as("owner", (tx) => tx.update(scmConnections).set({ orgId: other.orgId }).where(sql`id = ${conn.id}`)),
    );
    expect(code).toBe("42501");
  });
});

describe("scm_connections: xoá", () => {
  it("quản trị tổ chức xoá được; id lạ thì NOT_FOUND", async () => {
    const conn = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("xoa")));
    expect(await errorCode(() => as("tadmin", (tx) => removeConnection(tx, org.user("tadmin"), conn.id)))).toBe(
      "ORG_ROLE_REQUIRED",
    );
    await as("admin", (tx) => removeConnection(tx, org.user("admin"), conn.id));
    expect(await errorCode(() => as("admin", (tx) => removeConnection(tx, org.user("admin"), randomUUID())))).toBe(
      "SCM_CONNECTION_NOT_FOUND",
    );
  });
});

describe("checkConnection", () => {
  it("báo tạo được repo khi provider có quyền trên owner", async () => {
    const r = await checkConnection(createMemoryProvider("gitlab", ["thanh-toan"]), "thanh-toan");
    expect(r).toMatchObject({ ok: true, canCreate: true });
  });

  it("báo thiếu quyền trên owner khác", async () => {
    const r = await checkConnection(createMemoryProvider("gitlab", ["thanh-toan"]), "nguoi-khac");
    expect(r).toMatchObject({ ok: true, canCreate: false, missingScopes: ["installation:nguoi-khac"] });
  });
});
