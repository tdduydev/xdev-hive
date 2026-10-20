// Route nhận file Word với token cá nhân (spec 019 Q12): app desktop gửi `Authorization: Bearer hive_pat_…`. Token
// chỉ được nhận qua `withPersonalTokens` của app.ts, nên test dựng cả app thay vì gọi thẳng handler như
// modules/docsync/word/upload.db.test.ts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORD_IMPORT_UPLOAD_PATH } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { createApp } from "./app.ts";
import { configureProjectHome } from "./modules/docsync/homes.ts";
import { provideWordTools, type WordImportConfig } from "./modules/docsync/word/tools.ts";
import type { Auth } from "./modules/identity/index.ts";
import { createPool, type Jobs, loadConfig, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import { createMemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
// Không có phiên web: chỉ token cá nhân đăng nhập được. createApp đọc `baseURL` để chọn chế độ MCP.
const auth = {
  options: { baseURL: "http://hive.test" },
  api: { getSession: async () => null },
} as unknown as Auth;
const app = createApp({
  config: { port: 0, version: "t", publicUrl: "http://hive.test", masterKey },
  auth,
  pool,
  jobs,
  providerFactory: () => mem,
});
const ok = { ok: true, version: "3.12", reason: null };

let docx: Buffer;
let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
let homeId: string;

/** Token cá nhân như app desktop dùng: hive_pat_<tổ chức>_<bí mật>, hub chỉ giữ băm. */
async function pat(orgId: string, userId: string) {
  const token = `hive_pat_${orgId}_${randomBytes(32).toString("base64url")}`;
  await admin.query(
    `insert into hive.mcp_user_tokens (org_id, user_id, token_hash, prefix, client_id, expires_at)
     values ($1, $2, $3, 'hive_pat_test', 'xdev-hive-desktop', now() + interval '30 days')`,
    [orgId, userId, createHash("sha256").update(token).digest("hex")],
  );
  return token;
}

function send(token: string | null, orgId: string) {
  const form = new FormData();
  form.set("homeId", homeId);
  form.set("targetDir", "docs/srs");
  form.append("files", new File([new Uint8Array(docx)], "a.docx"));
  const headers = new Headers({ "x-hive-org": orgId });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://hive.test${WORD_IMPORT_UPLOAD_PATH}`, { method: "POST", headers, body: form }));
}

beforeAll(async () => {
  docx = await readFile(join(import.meta.dirname, "modules/docsync/word/fixtures/srs.docx"));
  provideWordTools({ config: loadConfig({}).wordImport as WordImportConfig, pandoc: ok, soffice: ok });
  org = await seedOrg(admin, `wupat-${tag}`);
  other = await seedOrg(admin, `wupat2-${tag}`);
  const key = `wupat${tag}`;
  const project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  const actor = { userId: org.user("tadmin"), orgId: org.orgId };
  const home = await withTenant(pool, actor, (tx) =>
    configureProjectHome(tx, { pool, jobs, masterKey, providerFactory: () => mem }, actor, {
      project: key,
      settings: {
        enabled: true,
        root: "docs/",
        repoSync: "direct",
        include: ["**/*.md"],
        exclude: [],
        assetsDir: "assets",
        repoChangesNeedReview: false,
        wordImportConfidential: false,
      },
    }),
  );
  homeId = home.id;
});

afterAll(async () => {
  provideWordTools(null);
  await Promise.all([admin.end(), pool.end()]);
});

describe("nhập Word bằng token cá nhân", () => {
  it("token của chủ trong tổ chức được nhận như phiên web", async () => {
    const response = await send(await pat(org.orgId, org.user("tmember")), org.orgId);
    expect(response.status, await response.clone().text()).toBe(201);
    const { importId } = (await response.json()) as { importId: string };
    const row = await admin.query("select created_by from hive.doc_word_imports where id = $1", [importId]);
    expect(row.rows).toEqual([{ created_by: org.user("tmember") }]);
  });

  it("thiếu token hay token của tổ chức khác thì từ chối", async () => {
    expect((await send(null, org.orgId)).status).toBe(401);
    const foreign = await pat(other.orgId, other.user("tmember"));
    // Token chỉ đăng nhập được vào tổ chức ghi trong nó.
    expect((await send(foreign, org.orgId)).status).toBe(401);
    // Đúng tổ chức của token nhưng nhà thuộc tổ chức khác: RLS giấu nhà.
    expect((await send(foreign, other.orgId)).status).toBe(404);
  });
});
