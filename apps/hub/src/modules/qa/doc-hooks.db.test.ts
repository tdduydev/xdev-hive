import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { archiveDoc, provideDocSaved, restoreDoc, saveDoc, saveDocFromSync } from "../knowledge/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { areaKeyPrefix, qaDocSaved } from "./doc-hooks.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
const projectKey = `qa${randomUUID().slice(0, 6)}`;

const asAdmin = <T>(run: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user("tadmin") }, run);
const principal = () => ({ kind: "user" as const, userId: org.user("tadmin") });

const file = (code: string, name: string) => `# ${code} Khu ${code}

### TC-${code}-001 ${name}

- Ưu tiên: P1
- Loại: tay
- Yêu cầu: FR-001

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang | Thấy trang |
`;

const fromWeb = (key: string, content: string, baseVersion = 0) =>
  asAdmin((tx) => saveDoc(tx, principal(), { key, content, baseVersion }));
const fromRepo = (key: string, content: string, baseVersion = 0) =>
  asAdmin((tx) =>
    saveDocFromSync(tx, {
      key,
      content,
      baseVersion,
      scope: { teamId: org.teamId, projectId },
      source: "repo",
    }),
  );

async function library(code: string) {
  const { rows } = await admin.query(
    `select a.code as area, a.parsed_version, a.archived_at is not null as archived, c.code, c.name, c.state, c.version
       from hive.qa_areas a left join hive.qa_cases c on c.area_id = a.id
      where a.project_id = $1 and a.code = $2 order by c.code`,
    [projectId, code],
  );
  return rows;
}

beforeAll(async () => {
  org = await seedOrg(admin, `qa-hooks-${randomUUID().slice(0, 8)}`);
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, org.orgId, org.user("owner")],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'gitlab', 'existing', 'xdev-team', $4, '{}', $6, $7)
       returning id`,
      [org.orgId, org.teamId, org.systemId, projectKey, scm, randomUUID(), org.user("owner")],
    )
  ).rows[0].id as string;
  await admin.query(
    `insert into hive.qa_project_settings (project_id, org_id, enabled, tc_dir) values ($1, $2, true, 'Test Cases/')`,
    [projectId, org.orgId],
  );
  provideDocSaved(qaDocSaved);
});

afterAll(async () => {
  provideDocSaved(undefined);
  await app.end();
  await admin.end();
});

describe("qaDocSaved", () => {
  it("tiền tố key dùng bản slug của thư mục TC", () => {
    expect(areaKeyPrefix("billing", "Test Cases/")).toBe("project/billing/test-cases/");
    expect(areaKeyPrefix("billing", "qa/Kiểm thử/")).toBe("project/billing/qa/kiem-thu/");
  });

  it("lưu trên web và đồng bộ từ repo cho cùng thư viện", async () => {
    await fromWeb(`project/${projectKey}/test-cases/web`, file("WEB", "Đăng nhập"));
    await fromRepo(`project/${projectKey}/test-cases/repo`, file("REPO", "Đăng nhập"));
    const web = await library("WEB");
    const repo = await library("REPO");
    expect(web).toEqual([
      expect.objectContaining({ parsed_version: 1, name: "Đăng nhập", state: "active", version: 1 }),
    ]);
    expect(repo.map(({ area, code, ...rest }) => rest)).toEqual(web.map(({ area, code, ...rest }) => rest));
    await fromRepo(`project/${projectKey}/test-cases/web`, file("WEB", "Đăng nhập lại"), 1);
    expect(await library("WEB")).toEqual([expect.objectContaining({ parsed_version: 2, version: 2 })]);
  });

  it("bỏ qua tài liệu ngoài thư mục TC và dự án chưa bật", async () => {
    await fromWeb(`project/${projectKey}/guide/ngoai`, file("NGOAI", "Ngoài"));
    expect(await library("NGOAI")).toEqual([]);
    await admin.query("update hive.qa_project_settings set enabled = false where project_id = $1", [projectId]);
    try {
      await fromWeb(`project/${projectKey}/test-cases/tat`, file("TAT", "Tắt"));
      expect(await library("TAT")).toEqual([]);
    } finally {
      await admin.query("update hive.qa_project_settings set enabled = true where project_id = $1", [projectId]);
    }
  });

  it("file lỗi vẫn lưu được tài liệu", async () => {
    const key = `project/${projectKey}/test-cases/loi`;
    const doc = await fromWeb(key, "# loi thiếu mã khu\n");
    expect(doc.version).toBe(1);
  });

  it("lưu trữ tài liệu ngừng mọi TC, khôi phục đọc lại file", async () => {
    const key = `project/${projectKey}/test-cases/luu-tru`;
    await fromWeb(key, file("LUU", "Lưu trữ"));
    await asAdmin((tx) => archiveDoc(tx, principal(), { key, baseVersion: 1 }));
    expect(await library("LUU")).toEqual([expect.objectContaining({ archived: true, state: "retired" })]);
    await asAdmin((tx) => restoreDoc(tx, principal(), { key, baseVersion: 1 }));
    expect(await library("LUU")).toEqual([expect.objectContaining({ archived: false, state: "active", version: 1 })]);
  });
});
