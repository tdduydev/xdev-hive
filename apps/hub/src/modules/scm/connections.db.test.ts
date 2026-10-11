import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  createConnection,
  createProviderFactory,
  listConnections,
  loadConnection,
  loadConnectionForAdmin,
  removeConnection,
} from "./connections.ts";
import { createMemoryProvider } from "./memory.ts";
import { JSON_HEADERS, mockHttp } from "./mock-http.ts";
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

describe("scm_connections: GitHub chế độ token", () => {
  const TOKEN = "github_pat_bi_mat_456";
  const tokenInput = (name: string) =>
    ({
      kind: "github",
      authMode: "token",
      name,
      baseUrl: "https://ghe.example.com/api/v3",
      defaultOwner: "thanh-toan",
      token: TOKEN,
    }) as const;

  let http: ReturnType<typeof mockHttp> | undefined;
  afterEach(async () => {
    http?.agent.assertNoPendingInterceptors();
    await http?.agent.close();
    http = undefined;
  });

  it("lưu token mã hoá, không trả token ra, audit không kèm token", async () => {
    const conn = await as("admin", (tx) => createConnection(tx, master, org.user("admin"), tokenInput("GHE token")));
    expect(conn).toMatchObject({ kind: "github", authMode: "token", appId: null, installationId: null });
    expect(JSON.stringify(conn)).not.toContain(TOKEN);
    expect(JSON.stringify(await as("tmember", (tx) => listConnections(tx)))).not.toContain(TOKEN);
    const raw = await admin.query("select secret_enc, auth_mode from hive.scm_connections where id = $1", [conn.id]);
    expect(raw.rows[0]).toMatchObject({ auth_mode: "token" });
    expect(raw.rows[0].secret_enc).not.toContain(TOKEN);
    const audit = await admin.query("select data from hive.audit_log where target_id = $1", [conn.id]);
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);
    const loaded = await as("tmember", (tx) => loadConnection(tx, master, conn.id));
    expect(loaded?.secret).toEqual({ token: TOKEN });
  });

  it("kết nối GitHub không ghi chế độ thì là app; GitLab đọc ra là token", async () => {
    const gh = await as("owner", (tx) =>
      createConnection(tx, master, org.user("owner"), {
        kind: "github",
        name: "App cũ",
        defaultOwner: "thanh-toan",
        appId: "1",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
        installationId: 2,
      }),
    );
    expect(gh.authMode).toBe("app");
    const gl = await as("owner", (tx) => createConnection(tx, master, org.user("owner"), gitlabInput("gl-che-do")));
    // Giả lập dòng GitLab có trước cột auth_mode: nhận giá trị mặc định "app".
    await admin.query("update hive.scm_connections set auth_mode = 'app' where id = $1", [gl.id]);
    const list = await as("owner", (tx) => listConnections(tx));
    expect(list.find((c) => c.id === gl.id)?.authMode).toBe("token");
  });

  it("test(): dựng provider token với baseUrl Enterprise và kiểm quyền", async () => {
    const conn = await as("admin", (tx) => createConnection(tx, master, org.user("admin"), tokenInput("GHE test")));
    http = mockHttp();
    const pool = http.agent.get("https://ghe.example.com");
    pool
      .intercept({ path: "/api/v3/user", method: "GET", headers: { authorization: (v: string) => v.endsWith(TOKEN) } })
      .reply(200, { login: "duy" }, { headers: { "content-type": "application/json", "x-oauth-scopes": "repo" } });
    pool
      .intercept({ path: "/api/v3/orgs/thanh-toan", method: "GET" })
      .reply(200, { login: "thanh-toan" }, JSON_HEADERS);
    const resolved = await as("admin", (tx) => loadConnectionForAdmin(tx, master, org.user("admin"), conn.id));
    const r = await checkConnection(createProviderFactory({ fetch: http.fetch })(resolved), resolved.defaultOwner);
    expect(r).toMatchObject({ ok: true, canCreate: true, missingScopes: [], unverifiedScopes: [] });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("test() với fine-grained token: báo quyền chưa kiểm trước được", async () => {
    const conn = await as("admin", (tx) => createConnection(tx, master, org.user("admin"), tokenInput("GHE fine")));
    http = mockHttp();
    const pool = http.agent.get("https://ghe.example.com");
    pool.intercept({ path: "/api/v3/user", method: "GET" }).reply(200, { login: "duy" }, JSON_HEADERS);
    pool
      .intercept({ path: "/api/v3/orgs/thanh-toan", method: "GET" })
      .reply(200, { login: "thanh-toan" }, JSON_HEADERS);
    const resolved = await as("admin", (tx) => loadConnectionForAdmin(tx, master, org.user("admin"), conn.id));
    const r = await checkConnection(createProviderFactory({ fetch: http.fetch })(resolved), "thanh-toan");
    expect(r).toMatchObject({ ok: true, canCreate: true, missingScopes: [] });
    expect(r.unverifiedScopes).toContain("administration:write");
    expect(r.message).toContain("chưa kiểm trước được");
  });

  it("test() với token sai: ok=false, báo token không hợp lệ", async () => {
    const conn = await as("admin", (tx) => createConnection(tx, master, org.user("admin"), tokenInput("GHE sai")));
    http = mockHttp();
    http.agent
      .get("https://ghe.example.com")
      .intercept({ path: "/api/v3/user", method: "GET" })
      .reply(401, { message: "Bad credentials" }, JSON_HEADERS);
    const resolved = await as("admin", (tx) => loadConnectionForAdmin(tx, master, org.user("admin"), conn.id));
    const r = await checkConnection(createProviderFactory({ fetch: http.fetch })(resolved), "thanh-toan");
    expect(r).toMatchObject({ ok: false, canCreate: false });
    expect(r.message).toContain("token không hợp lệ");
  });
});
