import { randomUUID } from "node:crypto";
import { testArea, testCaseDetail, testCaseListInput, testCaseRow } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, seedOrg } from "../../../test/org-fixture.ts";
import { provideDocSaved, saveDoc } from "../knowledge/index.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import { qaDocSaved } from "./doc-hooks.ts";
import { createArea, listAreas } from "./routes/areas.ts";
import { getCase, listCases } from "./routes/cases.ts";
import { getProjectSettings, updateProjectSettings } from "./routes/project-settings.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let org: Awaited<ReturnType<typeof seedOrg>>;
let projectId: string;
let scm: string;
const projectKey = `qr${randomUUID().slice(0, 6)}`;
const queued: unknown[] = [];
const jobs = { send: async (...args: unknown[]) => queued.push(args) } as never;

const as = <T>(who: string, run: (tx: Tx, userId: string) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user(who) }, (tx) => run(tx, org.user(who)));
const update = (who: string, input: { enabled?: boolean; tcDir?: string }) =>
  as(who, (tx, userId) => updateProjectSettings(tx, { jobs }, { userId, orgId: org.orgId }, { projectKey, ...input }));
const save = (key: string, content: string, baseVersion = 0) =>
  as("tadmin", (tx, userId) => saveDoc(tx, { kind: "user", userId }, { key, content, baseVersion }));
const list = (input: Record<string, unknown> = {}) =>
  as("tviewer", (tx, userId) => listCases(tx, userId, testCaseListInput.parse({ projectKey, ...input })));
const codes = async (input: Record<string, unknown> = {}) => (await list(input)).items.map((c) => c.code);

const tc = (code: string, name: string, meta: string) => `### ${code} ${name}

- Ưu tiên: P1
- Loại: tay
- Yêu cầu: FR-001
${meta}

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang | Thấy trang |
`;

beforeAll(async () => {
  org = await seedOrg(admin, `qa-routes-${randomUUID().slice(0, 8)}`);
  scm = randomUUID();
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
  provideDocSaved(qaDocSaved);
});

afterAll(async () => {
  provideDocSaved(undefined);
  await app.end();
  await admin.end();
});

describe("projectSettings", () => {
  it("chưa bật vẫn xem được; bật cần projects.settings", async () => {
    expect(await as("tviewer", (tx, u) => getProjectSettings(tx, u, projectKey))).toEqual({
      enabled: false,
      tcDir: "test-cases/",
      includeResult: null,
    });
    expect(await errorCode(() => update("tmember", { enabled: true }))).toBe("QA_PERMISSION_REQUIRED");
  });

  it("bật lần đầu: báo no-home khi dự án chưa có docs home, đọc file đã lưu lúc tắt, ghi audit", async () => {
    await save(`project/${projectKey}/test-cases/truoc`, `# TRUOC Khu trước\n\n${tc("TC-TRUOC-001", "Có sẵn", "")}`);
    expect(await update("tadmin", { enabled: true })).toEqual({
      enabled: true,
      tcDir: "test-cases/",
      includeResult: "no-home",
    });
    const areas = await as("tviewer", (tx, u) => listAreas(tx, u, projectKey));
    expect(areas.items).toEqual([expect.objectContaining({ code: "TRUOC", activeCases: 1, archived: false })]);
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'qa.project_settings.update'",
      [org.orgId],
    );
    expect(audit.rows.map((r) => r.data.after)).toEqual([
      { enabled: true, tcDir: "test-cases/", includeResult: "no-home" },
    ]);
  });

  it("đổi thư mục: thêm include vào docs home, khu thư mục cũ thành lưu trữ", async () => {
    await admin.query(
      `insert into hive.doc_homes (org_id, scope, project_id, connection_id, owner, name, branch, root, include,
         configured_by, status, mode)
       values ($1, 'project', $2, $3, 'xdev-team', $4, 'main', 'docs/', '{guide/**}', $5, 'active', 'off')`,
      [org.orgId, projectId, scm, projectKey, org.user("tadmin")],
    );
    await save(`project/${projectKey}/qa/moi`, `# MOI Khu mới\n\n${tc("TC-MOI-001", "Mới", "")}`);
    expect(await update("tadmin", { tcDir: "qa/" })).toMatchObject({ tcDir: "qa/", includeResult: "added" });
    const home = await admin.query("select include from hive.doc_homes where project_id = $1", [projectId]);
    expect(home.rows[0].include).toEqual(["guide/**", "docs/qa/**"]);
    const areas = await as("tviewer", (tx, u) => listAreas(tx, u, projectKey));
    expect(areas.items.map((a) => [a.code, a.archived, a.activeCases])).toEqual([
      ["MOI", false, 1],
      ["TRUOC", true, 0],
    ]);
    await update("tadmin", { tcDir: "test-cases/" });
  });
});

describe("areas", () => {
  it("tạo khu từ mẫu, trả docKey; mã trùng báo QA_AREA_CODE_TAKEN", async () => {
    const created = await as("tadmin", (tx, u) =>
      createArea(tx, u, { projectKey, code: "DANGNHAP", name: "Đăng nhập" }),
    );
    expect(created.docKey).toBe(`project/${projectKey}/test-cases/dangnhap`);
    expect(testArea.parse(created.area)).toMatchObject({ code: "DANGNHAP", name: "Đăng nhập", activeCases: 1 });
    const again = () => as("tadmin", (tx, u) => createArea(tx, u, { projectKey, code: "DANGNHAP", name: "Khác" }));
    await expect(again()).rejects.toMatchObject({
      code: "QA_AREA_CODE_TAKEN",
      message: `Mã khu \`DANGNHAP\` đã dùng ở \`${created.docKey}\`. Chọn mã khu khác.`,
    });
    const viewer = () => as("tviewer", (tx, u) => createArea(tx, u, { projectKey, code: "XEM", name: "Xem" }));
    expect(await errorCode(viewer)).toBe("QA_PERMISSION_REQUIRED");
  });

  it("danh sách khu kèm lỗi đọc file", async () => {
    await save(`project/${projectKey}/test-cases/loi`, "# LOIDOC Khu lỗi\n\n### TC-LOIDOC-001 Thiếu bảng\n");
    const { items } = await as("tviewer", (tx, u) => listAreas(tx, u, projectKey));
    const bad = items.find((a) => a.code === "LOIDOC");
    expect(bad).toMatchObject({ parsedVersion: null, errorsVersion: 1 });
    expect(bad?.parseErrors.length).toBeGreaterThan(0);
  });

  it("thư viện tắt thì route thư viện báo QA_LIBRARY_DISABLED", async () => {
    await admin.query("update hive.qa_project_settings set enabled = false where project_id = $1", [projectId]);
    try {
      expect(await errorCode(() => as("tviewer", (tx, u) => listAreas(tx, u, projectKey)))).toBe("QA_LIBRARY_DISABLED");
    } finally {
      await admin.query("update hive.qa_project_settings set enabled = true where project_id = $1", [projectId]);
    }
  });
});

describe("cases", () => {
  const key = () => `project/${projectKey}/test-cases/loc`;
  let caseId: (code: string) => Promise<string>;

  beforeAll(async () => {
    const file = (name: string) =>
      [
        "# LOC Khu lọc\n",
        tc("TC-LOC-001", name, "- Nhãn: smoke"),
        tc("TC-LOC-002", "Thanh toán", "- Nhãn: hoi-quy").replace("FR-001", "FR-002").replace("P1", "P2"),
        tc("TC-LOC-003", "Xuất hoá đơn", "").replace("Loại: tay", "Loại: tự động\n- Script: e2e/hoa-don.spec.ts"),
      ].join("\n");
    await save(key(), file("Đăng nhập"));
    await save(key(), file("Đăng nhập bằng SSO"), 1);
    caseId = async (code) =>
      (await admin.query("select id from hive.qa_cases where project_id = $1 and code = $2", [projectId, code])).rows[0]
        .id;
  });

  it("lọc theo FR-009, mặc định chỉ TC đang dùng", async () => {
    expect(await codes({ area: "LOC" })).toEqual(["TC-LOC-001", "TC-LOC-002", "TC-LOC-003"]);
    expect(await codes({ q: "sso" })).toEqual(["TC-LOC-001"]);
    expect(await codes({ q: "loc-002" })).toEqual(["TC-LOC-002"]);
    expect(await codes({ q: "%" })).toEqual([]);
    expect(await codes({ label: "hoi-quy" })).toEqual(["TC-LOC-002"]);
    expect(await codes({ requirement: "FR-002" })).toEqual(["TC-LOC-002"]);
    expect(await codes({ area: "LOC", priority: "P1", kind: "manual" })).toEqual(["TC-LOC-001"]);
    expect(await codes({ kind: "automated" })).toEqual(["TC-LOC-003"]);
    // TRUOC quay lại khi trả thư mục cũ, còn MOI ở `qa/` thành lưu trữ.
    expect(await codes({ state: "retired" })).toEqual(["TC-MOI-001"]);
  });

  it("lọc trạng thái hiện tại và phân trang theo mã", async () => {
    await admin.query("update hive.qa_case_status set ci_status = 'failed', ci_at = now() where case_id = $1", [
      await caseId("TC-LOC-002"),
    ]);
    expect(await codes({ area: "LOC", currentStatus: "failed" })).toEqual(["TC-LOC-002"]);
    expect(await codes({ area: "LOC", currentStatus: "none" })).toEqual(["TC-LOC-001", "TC-LOC-003"]);
    const first = await list({ area: "LOC", limit: 2 });
    expect(first.items.map((c) => testCaseRow.parse(c).code)).toEqual(["TC-LOC-001", "TC-LOC-002"]);
    expect(first.items[1]).toMatchObject({ currentStatus: "failed", currentSource: "ci" });
    const second = await list({ area: "LOC", limit: 2, cursor: first.nextCursor });
    expect(second).toEqual({ items: [expect.objectContaining({ code: "TC-LOC-003" })], nextCursor: null });
  });

  it("chi tiết: nội dung, các phiên bản mới trước, kết quả CI và tay gần nhất", async () => {
    const get = (code: string) => as("tviewer", (tx, u) => getCase(tx, u, { projectKey, code }));
    const plain = testCaseDetail.parse(await get("TC-LOC-001"));
    expect(plain).toMatchObject({
      name: "Đăng nhập bằng SSO",
      version: 2,
      docKey: key(),
      line: 3,
      labels: ["smoke"],
      steps: [{ n: 1, action: "Mở trang", expected: "Thấy trang" }],
      latestCi: null,
      latestManual: null,
    });
    expect(plain.versions.map((v) => [v.version, v.docVersion, v.content.name])).toEqual([
      [2, 2, "Đăng nhập bằng SSO"],
      [1, 1, "Đăng nhập"],
    ]);

    const id = await caseId("TC-LOC-002");
    const area = (await admin.query("select area_id from hive.qa_cases where id = $1", [id])).rows[0].area_id;
    const source = (
      await admin.query(
        `insert into hive.qa_ci_sources (org_id, project_id, label, repo_path, repo_web_url, mode, reference_branch,
           credential, created_by)
         values ($1, $2, 'e2e', 'xdev-team/app', 'https://gitlab.example.test/xdev-team/app/', 'pipeline-report', 'main',
           'gitlab', $3) returning id`,
        [org.orgId, projectId, org.user("tadmin")],
      )
    ).rows[0].id;
    const run = (
      await admin.query(
        `insert into hive.qa_ci_runs (org_id, source_id, pipeline_id, pipeline_status, ref, sha, kind, read_state)
         values ($1, $2, 4021, 'failed', 'main', repeat('a', 40), 'branch', 'done') returning id`,
        [org.orgId, source],
      )
    ).rows[0].id;
    await admin.query(
      `insert into hive.qa_ci_run_cases (run_id, case_id, org_id, area_id, status, worst_job_id)
       values ($1, $2, $3, $4, 'failed', 9001)`,
      [run, id, org.orgId, area],
    );
    await admin.query("update hive.qa_case_status set ci_run_id = $2 where case_id = $1", [id, run]);
    const round = (
      await admin.query(
        `insert into hive.qa_rounds (org_id, project_id, name, start_date, planned_end_date, created_by)
         values ($1, $2, 'Đợt 1', current_date, current_date, $3) returning id`,
        [org.orgId, projectId, org.user("tadmin")],
      )
    ).rows[0].id;
    await admin.query(
      `insert into hive.qa_round_cases (org_id, round_id, case_id, case_version_at_add, status, recorded_by,
         recorded_at)
       values ($1, $2, $3, 1, 'deferred', $4, now() - interval '1 hour')`,
      [org.orgId, round, id, org.user("tmember")],
    );

    const detail = testCaseDetail.parse(await get("TC-LOC-002"));
    expect(detail.latestCi).toMatchObject({
      status: "failed",
      runId: run,
      sourceLabel: "e2e",
      pipelineId: 4021,
      pipelineUrl: "https://gitlab.example.test/xdev-team/app/-/pipelines/4021",
      jobUrl: "https://gitlab.example.test/xdev-team/app/-/jobs/9001",
    });
    // Chuyển đợt sau không tính vào trạng thái hiện tại nhưng vẫn hiện ở ô kết quả tay.
    expect(detail.latestManual).toMatchObject({
      status: "deferred",
      roundId: round,
      roundName: "Đợt 1",
      recordedBy: { id: org.user("tmember") },
    });
    expect(detail).toMatchObject({ currentStatus: "failed", currentSource: "ci" });
  });

  it("mã không có trong dự án báo không tìm thấy", async () => {
    expect(await errorCode(() => as("tviewer", (tx, u) => getCase(tx, u, { projectKey, code: "TC-LOC-999" })))).toBe(
      "QA_CASE_NOT_FOUND",
    );
  });
});
