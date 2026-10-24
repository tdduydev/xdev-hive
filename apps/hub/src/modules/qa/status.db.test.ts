import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import {
  addCaseStatusRows,
  applyCiRun,
  recomputeCaseStatus,
  recomputeCiStatus,
  recomputeManualStatus,
  worstStatus,
} from "./status.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);

let orgId: string;
let userId: string;
let projectId: string;
let areaId: string;
let roundId: string;
let sources: [string, string];
let caseNo = 0;
let pipelineNo = 0;

const asOrg = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId, userId }, run);

async function newCase(): Promise<string> {
  const id = randomUUID();
  caseNo += 1;
  await admin.query(
    `insert into hive.qa_cases (id, org_id, project_id, area_id, code, name, priority, kind, requirements, steps, line,
       content_hash)
     values ($1, $2, $3, $4, $5, 'Ca thử', 'P1', 'manual', '{FR-001}', '[{"n":1,"action":"a","expected":"b"}]', 1, 'h')`,
    [id, orgId, projectId, areaId, `TC-TT-${String(caseNo).padStart(3, "0")}`],
  );
  await asOrg((tx) => addCaseStatusRows(tx, [{ caseId: id, projectId, areaId }]));
  return id;
}

type RunOpts = { source?: string; at: string; reference?: boolean; kind?: "branch" | "mr"; state?: string };
async function ciRun(cases: Record<string, string>, opts: RunOpts): Promise<string> {
  const id = randomUUID();
  pipelineNo += 1;
  await admin.query(
    `insert into hive.qa_ci_runs (id, org_id, source_id, pipeline_id, read_state, pipeline_status, ref, sha, kind,
       is_reference, finished_at)
     values ($1, $2, $3, $4, $5, 'success', 'main', $6, $7, $8, $9)`,
    [
      id,
      orgId,
      opts.source ?? sources[0],
      pipelineNo,
      opts.state ?? "done",
      "a".repeat(40),
      opts.kind ?? "branch",
      opts.reference ?? true,
      opts.at,
    ],
  );
  for (const [caseId, status] of Object.entries(cases))
    await admin.query(
      "insert into hive.qa_ci_run_cases (run_id, case_id, org_id, area_id, status) values ($1, $2, $3, $4, $5)",
      [id, caseId, orgId, areaId, status],
    );
  return id;
}

async function manual(caseId: string, status: string, at: string | null, round = roundId): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into hive.qa_round_cases (id, org_id, round_id, case_id, case_version_at_add, status, note, recorded_by,
       recorded_at, revision)
     values ($1, $2, $3, $4, 1, $5, 'ghi chú', $6, $7, 1)`,
    [id, orgId, round, caseId, status, at ? userId : null, at],
  );
  return id;
}

async function statusOf(caseId: string) {
  const { rows } = await admin.query(
    `select ci_status, ci_at, ci_run_id, manual_status, manual_round_case_id, current_status, current_source
       from hive.qa_case_status where case_id = $1`,
    [caseId],
  );
  const r = rows[0];
  return r && { ...r, ci_at: r.ci_at?.toISOString() ?? null };
}

beforeAll(async () => {
  const org = await seedOrg(admin, `qa-status-${randomUUID().slice(0, 8)}`);
  orgId = org.orgId;
  userId = org.user("owner");
  const scm = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'gitlab', 'gl', 'fixture', $3)",
    [scm, orgId, userId],
  );
  projectId = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, settings, idempotency_key, created_by)
       values ($1, $2, $3, 'billing', 'billing', $4, 'gitlab', 'existing', 'xdev-team', 'billing', '{}', $5, $6)
       returning id`,
      [orgId, org.teamId, org.systemId, scm, randomUUID(), userId],
    )
  ).rows[0].id as string;
  areaId = (
    await admin.query(
      `insert into hive.qa_areas (org_id, project_id, code, name, doc_key) values ($1, $2, 'TT', 'Thử', 'test-cases/tt.md')
       returning id`,
      [orgId, projectId],
    )
  ).rows[0].id as string;
  const source = async (label: string) =>
    (
      await admin.query(
        `insert into hive.qa_ci_sources (org_id, project_id, label, repo_path, repo_web_url, mode, artifact_path,
           reference_branch, credential, created_by)
         values ($1, $2, $3, 'xdev-team/billing', 'https://gitlab.example.invalid/xdev-team/billing', 'junit-artifact',
           'reports/junit.xml', 'main', 'gitlab-ci', $4)
         returning id`,
        [orgId, projectId, label, userId],
      )
    ).rows[0].id as string;
  sources = [await source("e2e"), await source("api")];
  const round = async (name: string) =>
    (
      await admin.query(
        `insert into hive.qa_rounds (org_id, project_id, name, start_date, planned_end_date, created_by)
         values ($1, $2, $3, '2026-10-20', '2026-10-24', $4) returning id`,
        [orgId, projectId, name, userId],
      )
    ).rows[0].id as string;
  roundId = await round("Đợt 1");
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe("worstStatus (FR-054)", () => {
  it("failed > other > flaky > skipped > passed > chưa có", () => {
    expect(worstStatus(["passed", "skipped", "flaky", "other", "failed"])).toBe("failed");
    expect(worstStatus(["passed", "flaky", "other"])).toBe("other");
    expect(worstStatus(["skipped", "flaky", "passed"])).toBe("flaky");
    expect(worstStatus(["passed", null, "skipped"])).toBe("skipped");
    expect(worstStatus([null])).toBeNull();
    expect(worstStatus([])).toBeNull();
  });
});

describe("qa_case_status (D12, FR-052)", () => {
  it("TC mới có dòng rỗng, thêm lần nữa không lỗi", async () => {
    const tc = await newCase();
    await asOrg((tx) => addCaseStatusRows(tx, [{ caseId: tc, projectId, areaId }]));
    expect(await statusOf(tc)).toMatchObject({ ci_status: null, manual_status: null, current_status: null });
  });

  it("chỉ lần chạy done, tham chiếu, trên nhánh mới ghi kết quả CI; skipped tính là có kết quả", async () => {
    const tc = await newCase();
    for (const opts of [
      { at: "2026-10-20T08:00:00Z", reference: false },
      { at: "2026-10-20T08:00:00Z", kind: "mr" as const },
      { at: "2026-10-20T08:00:00Z", state: "error" },
    ]) {
      await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "failed" }, opts)));
      expect((await statusOf(tc)).ci_status).toBeNull();
    }
    const run = await ciRun({ [tc]: "skipped" }, { at: "2026-10-20T09:00:00Z" });
    await asOrg((tx) => applyCiRun(tx, run));
    expect(await statusOf(tc)).toMatchObject({
      ci_status: "skipped",
      ci_at: "2026-10-20T09:00:00.000Z",
      ci_run_id: run,
      current_status: "skipped",
      current_source: "ci",
    });
  });

  it("lần chạy cũ hơn không đè; cùng giờ ở hai nguồn thì giữ trạng thái xấu hơn", async () => {
    const tc = await newCase();
    const latest = await ciRun({ [tc]: "flaky" }, { at: "2026-10-21T08:00:00Z" });
    await asOrg((tx) => applyCiRun(tx, latest));
    await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "failed" }, { at: "2026-10-20T08:00:00Z" })));
    expect((await statusOf(tc)).ci_run_id).toBe(latest);
    const same = { at: "2026-10-21T08:00:00Z", source: sources[1] };
    await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "passed" }, same)));
    expect((await statusOf(tc)).ci_status).toBe("flaky");
    await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "failed" }, same)));
    expect((await statusOf(tc)).ci_status).toBe("failed");
  });

  it("bên mới hơn thắng, bằng giờ thì kết quả tay thắng", async () => {
    const tc = await newCase();
    await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "passed" }, { at: "2026-10-21T08:00:00Z" })));
    const rc = await manual(tc, "failed", "2026-10-21T08:00:00Z");
    await asOrg((tx) => recomputeManualStatus(tx, projectId, [tc]));
    expect(await statusOf(tc)).toMatchObject({
      manual_status: "failed",
      manual_round_case_id: rc,
      current_status: "failed",
      current_source: "manual",
    });
    await asOrg(async (tx) => applyCiRun(tx, await ciRun({ [tc]: "passed" }, { at: "2026-10-21T08:00:01Z" })));
    expect(await statusOf(tc)).toMatchObject({ current_status: "passed", current_source: "ci" });
  });

  it("kết quả tay không tính thì lùi về kết quả tính được trước đó", async () => {
    const tc = await newCase();
    const roundB = (
      await admin.query(
        `insert into hive.qa_rounds (org_id, project_id, name, start_date, planned_end_date, created_by)
         values ($1, $2, 'Đợt 2', '2026-10-22', '2026-10-24', $3) returning id`,
        [orgId, projectId, userId],
      )
    ).rows[0].id as string;
    const first = await manual(tc, "other", "2026-10-21T08:00:00Z");
    await manual(tc, "deferred", "2026-10-22T08:00:00Z", roundB);
    await asOrg((tx) => recomputeManualStatus(tx, projectId, [tc]));
    expect(await statusOf(tc)).toMatchObject({ manual_status: "other", manual_round_case_id: first });
    await admin.query("update hive.qa_round_cases set status = 'untested' where id = $1", [first]);
    await asOrg((tx) => recomputeManualStatus(tx, projectId, [tc]));
    expect(await statusOf(tc)).toMatchObject({ manual_status: null, manual_round_case_id: null, current_status: null });
  });

  it("gửi lại cùng pipeline: TC rời báo cáo lùi về lần chạy trước", async () => {
    const [a, b] = [await newCase(), await newCase()];
    const before = await ciRun({ [a]: "passed", [b]: "passed" }, { at: "2026-10-20T08:00:00Z" });
    const run = await ciRun({ [a]: "failed", [b]: "failed" }, { at: "2026-10-21T08:00:00Z" });
    await asOrg(async (tx) => {
      await applyCiRun(tx, before);
      await applyCiRun(tx, run);
    });
    await admin.query("delete from hive.qa_ci_run_cases where run_id = $1", [run]);
    await admin.query(
      "insert into hive.qa_ci_run_cases (run_id, case_id, org_id, area_id, status) values ($1, $2, $3, $4, 'passed')",
      [run, a, orgId, areaId],
    );
    await asOrg((tx) => recomputeCiStatus(tx, projectId, [a, b]));
    expect(await statusOf(a)).toMatchObject({ ci_status: "passed", ci_run_id: run });
    expect(await statusOf(b)).toMatchObject({ ci_status: "passed", ci_run_id: before });
  });

  it("đổi nhánh tham chiếu và xoá nguồn tính lại cả dự án", async () => {
    const tc = await newCase();
    const own = await admin.query(
      `insert into hive.qa_ci_sources (org_id, project_id, label, repo_path, repo_web_url, mode, artifact_path,
         reference_branch, credential, created_by)
       values ($1, $2, 'unit', 'xdev-team/billing', 'https://gitlab.example.invalid/xdev-team/billing',
         'junit-artifact', 'reports/junit.xml', 'main', 'gitlab-ci', $3)
       returning id`,
      [orgId, projectId, userId],
    );
    const source = own.rows[0].id as string;
    const run = await ciRun({ [tc]: "failed" }, { at: "2026-10-23T08:00:00Z", source });
    await asOrg((tx) => applyCiRun(tx, run));
    await manual(tc, "passed", "2026-10-22T08:00:00Z");
    await asOrg((tx) => recomputeManualStatus(tx, projectId, [tc]));
    expect((await statusOf(tc)).current_status).toBe("failed");

    await admin.query("update hive.qa_ci_runs set is_reference = false where source_id = $1", [source]);
    await asOrg((tx) => recomputeCiStatus(tx, projectId));
    expect(await statusOf(tc)).toMatchObject({ ci_status: null, current_status: "passed", current_source: "manual" });

    await admin.query("update hive.qa_ci_runs set is_reference = true where source_id = $1", [source]);
    await asOrg((tx) => recomputeCiStatus(tx, projectId));
    expect((await statusOf(tc)).ci_run_id).toBe(run);
    await admin.query("delete from hive.qa_ci_sources where id = $1", [source]);
    await asOrg((tx) => recomputeCaseStatus(tx, projectId));
    expect(await statusOf(tc)).toMatchObject({ ci_status: null, ci_run_id: null, current_status: "passed" });
  });
});
