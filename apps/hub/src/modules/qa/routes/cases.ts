import {
  TEST_CASE_CODE,
  type TestCaseContent,
  type TestCaseDetail,
  type TestCaseListInput,
  type TestCaseRow,
} from "@xdev-hive/contracts";
import { and, arrayContains, asc, desc, eq, gt, ilike, isNull, or, type SQL, sql } from "drizzle-orm";
import { NotFoundError, type Tx } from "../../platform/index.ts";
import { qaProject } from "../access.ts";
import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";
import { qaAreas, qaCaseStatus, qaCases, qaCaseVersions } from "../schema.ts";

const iso = (at: Date | string) => new Date(at).toISOString();

// Mã TC là duy nhất trong dự án và không đổi, nên sắp theo mã thì cursor chỉ cần mã của dòng cuối.
const encodeCursor = (code: string) => Buffer.from(code).toString("base64url");
function decodeCursor(cursor: string): string | null {
  const code = Buffer.from(cursor, "base64url").toString();
  return TEST_CASE_CODE.test(code) ? code : null;
}

const rowColumns = {
  id: qaCases.id,
  code: qaCases.code,
  name: qaCases.name,
  areaCode: qaAreas.code,
  priority: qaCases.priority,
  kind: qaCases.kind,
  requirements: qaCases.requirements,
  labels: qaCases.labels,
  state: qaCases.state,
  version: qaCases.version,
  currentStatus: qaCaseStatus.currentStatus,
  currentSource: qaCaseStatus.currentSource,
};

// Cột text đã có check cùng tập giá trị với enum của hợp đồng.
const toRow = (r: { [K in keyof typeof rowColumns]: unknown }): TestCaseRow => r as TestCaseRow;

const casesWithStatus = (tx: Tx) =>
  tx
    .select(rowColumns)
    .from(qaCases)
    .innerJoin(qaAreas, eq(qaAreas.id, qaCases.areaId))
    .leftJoin(qaCaseStatus, eq(qaCaseStatus.caseId, qaCases.id));

export async function listCases(
  tx: Tx,
  userId: string,
  input: TestCaseListInput,
): Promise<{ items: TestCaseRow[]; nextCursor: string | null }> {
  const { project } = await qaProject(tx, userId, input.projectKey, "qa.read");
  const where: (SQL | undefined)[] = [eq(qaCases.projectId, project.id), eq(qaCases.state, input.state)];
  if (input.q) {
    const pattern = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(qaCases.code, pattern), ilike(qaCases.name, pattern)));
  }
  if (input.area) where.push(eq(qaAreas.code, input.area));
  // `@>` thay cho `= any(...)` để dùng được index GIN của hai cột mảng.
  if (input.label) where.push(arrayContains(qaCases.labels, [input.label]));
  if (input.requirement) where.push(arrayContains(qaCases.requirements, [input.requirement]));
  if (input.priority) where.push(eq(qaCases.priority, input.priority));
  if (input.kind) where.push(eq(qaCases.kind, input.kind));
  if (input.currentStatus === "none") where.push(isNull(qaCaseStatus.currentStatus));
  else if (input.currentStatus) where.push(eq(qaCaseStatus.currentStatus, input.currentStatus));
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  if (after) where.push(gt(qaCases.code, after));
  const rows = await casesWithStatus(tx)
    .where(and(...where))
    .orderBy(asc(qaCases.code))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map(toRow),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.code) : null,
  };
}

async function latestCi(tx: Tx, caseId: string): Promise<TestCaseDetail["latestCi"]> {
  const { rows } = await tx.execute<{
    status: string;
    at: Date | string;
    run_id: string;
    label: string;
    pipeline_id: string | number;
    ref: string;
    sha: string;
    repo_web_url: string;
    job_id: string | number | null;
  }>(sql`
    select s.ci_status as status, s.ci_at as at, r.id as run_id, src.label, r.pipeline_id, r.ref, r.sha,
           src.repo_web_url, rc.worst_job_id as job_id
      from hive.qa_case_status s
      join hive.qa_ci_runs r on r.id = s.ci_run_id
      join hive.qa_ci_sources src on src.id = r.source_id
      left join hive.qa_ci_run_cases rc on rc.run_id = r.id and rc.case_id = s.case_id
     where s.case_id = ${caseId} and s.ci_status is not null`);
  const row = rows[0];
  if (!row) return null;
  // Liên kết dựng từ `repo_web_url` của nguồn, không nhận URL từ worker (FR-026).
  const web = row.repo_web_url.replace(/\/+$/, "");
  return {
    status: row.status as NonNullable<TestCaseDetail["latestCi"]>["status"],
    at: iso(row.at),
    runId: row.run_id,
    sourceLabel: row.label,
    pipelineId: Number(row.pipeline_id),
    ref: row.ref,
    sha: row.sha,
    pipelineUrl: `${web}/-/pipelines/${row.pipeline_id}`,
    jobUrl: row.job_id === null ? null : `${web}/-/jobs/${row.job_id}`,
  };
}

/** Lần ghi tay gần nhất ở mọi đợt, kể cả trạng thái không tính vào trạng thái hiện tại (FR-052). */
async function latestManual(tx: Tx, caseId: string): Promise<TestCaseDetail["latestManual"]> {
  const { rows } = await tx.execute<{
    status: string;
    at: Date | string;
    round_id: string;
    round_name: string;
    round_case_id: string;
    recorded_by: string | null;
    recorded_by_name: string | null;
  }>(sql`
    select rc.status, rc.recorded_at as at, r.id as round_id, r.name as round_name, rc.id as round_case_id,
           rc.recorded_by, u.name as recorded_by_name
      from hive.qa_round_cases rc
      join hive.qa_rounds r on r.id = rc.round_id
      left join auth."user" u on u.id = rc.recorded_by
     where rc.case_id = ${caseId} and rc.recorded_at is not null
     order by rc.recorded_at desc
     limit 1`);
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status as NonNullable<TestCaseDetail["latestManual"]>["status"],
    at: iso(row.at),
    roundId: row.round_id,
    roundName: row.round_name,
    roundCaseId: row.round_case_id,
    recordedBy: row.recorded_by ? { id: row.recorded_by, name: row.recorded_by_name ?? row.recorded_by } : null,
  };
}

export async function getCase(
  tx: Tx,
  userId: string,
  input: { projectKey: string; code: string },
): Promise<TestCaseDetail> {
  const { project } = await qaProject(tx, userId, input.projectKey, "qa.read");
  const [found] = await tx
    .select({
      row: rowColumns,
      script: qaCases.script,
      testData: qaCases.testData,
      preconditions: qaCases.preconditions,
      note: qaCases.note,
      steps: qaCases.steps,
      line: qaCases.line,
      docId: qaAreas.docId,
      docKey: qaAreas.docKey,
    })
    .from(qaCases)
    .innerJoin(qaAreas, eq(qaAreas.id, qaCases.areaId))
    .leftJoin(qaCaseStatus, eq(qaCaseStatus.caseId, qaCases.id))
    .where(and(eq(qaCases.projectId, project.id), eq(qaCases.code, input.code)));
  if (!found) throw new NotFoundError("QA_CASE_NOT_FOUND", `Không tìm thấy test case \`${input.code}\` trong dự án.`);
  const versions = await tx
    .select()
    .from(qaCaseVersions)
    .where(eq(qaCaseVersions.caseId, found.row.id))
    .orderBy(desc(qaCaseVersions.version));
  const { row, docId, docKey, ...content } = found;
  return {
    ...toRow(row),
    ...content,
    // Tài liệu đã xoá thì không đưa key cho editor mở vào chỗ trống.
    docKey: docId ? docKey : null,
    versions: versions.map((v) => ({
      version: v.version,
      docVersion: v.docVersion,
      createdAt: iso(v.createdAt),
      content: v.content as TestCaseContent,
    })),
    latestCi: await latestCi(tx, row.id),
    latestManual: await latestManual(tx, row.id),
  };
}

export function casesRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).cases;
  return {
    list: api.list.handler(({ context, input }) => listCases(context.tx, context.user.id, input)),
    get: api.get.handler(({ context, input }) => getCase(context.tx, context.user.id, input)),
    history: api.history.handler(notImplemented),
  };
}
