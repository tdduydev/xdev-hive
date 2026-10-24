import { QA_COUNTED_MANUAL_STATUSES, QA_STATUS_SEVERITY, type TestCurrentStatus } from "@xdev-hive/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { qaCaseStatus } from "./schema.ts";

// Bảng chiếu `qa_case_status` (research D12, FR-052, data-model "Luật cập nhật"). Mọi hàm chạy trong transaction ghi
// kết quả để dashboard không bao giờ thấy kết quả đã lưu mà trạng thái chưa đổi.

/** Trạng thái xấu nhất (FR-054); null khi chưa có kết quả nào. */
export function worstStatus(statuses: Iterable<TestCurrentStatus | null>): TestCurrentStatus | null {
  let worst: TestCurrentStatus | null = null;
  for (const s of statuses)
    if (s && (!worst || QA_STATUS_SEVERITY.indexOf(s) > QA_STATUS_SEVERITY.indexOf(worst))) worst = s;
  return worst;
}

/** Hạng của trạng thái trong SQL, sinh từ `QA_STATUS_SEVERITY` để truy vấn và hợp đồng cùng một thứ tự. */
export const severitySql = (column: SQL): SQL =>
  sql`case ${column} ${sql.join(
    QA_STATUS_SEVERITY.map((s, i) => sql`when ${s} then ${sql.raw(String(i + 1))}`),
    sql` `,
  )} else 0 end`;

// Chỉ lần chạy đã đọc xong trên nhánh tham chiếu mới tính (FR-052); run của MR không tính dù trùng nhánh.
const referenceRun = sql`r.read_state = 'done' and r.is_reference and r.kind = 'branch'`;
// Lần chạy thiếu giờ kết thúc vẫn có mốc để so với kết quả tay, cùng mốc mà hàm giữ dữ liệu dùng.
const runAt = sql`coalesce(r.finished_at, r.created_at)`;
const counted = sql.raw(QA_COUNTED_MANUAL_STATUSES.map((s) => `'${s}'`).join(", "));

const inScope = (projectId: string, caseIds?: readonly string[]) =>
  caseIds
    ? sql`cs.project_id = ${projectId} and cs.case_id in (${sql.join(
        caseIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`cs.project_id = ${projectId}`;

/** TC mới có dòng rỗng để dashboard đếm vào "Chưa có kết quả" mà không cần left join. */
export async function addCaseStatusRows(
  tx: Tx,
  cases: ReadonlyArray<{ caseId: string; projectId: string; areaId: string }>,
): Promise<void> {
  if (!cases.length) return;
  await tx
    .insert(qaCaseStatus)
    .values(cases.map((c) => ({ ...c, orgId: sql`hive.ctx_org()` })))
    .onConflictDoNothing();
}

/**
 * Lần chạy vừa sang `done`: chỉ ghi đè TC mà lần chạy này mới hơn, khỏi quét lịch sử. Cùng giờ với lần đang giữ (hai
 * nguồn xong cùng lúc) thì giữ trạng thái xấu hơn.
 */
export async function applyCiRun(tx: Tx, runId: string): Promise<void> {
  await tx.execute(sql`
    update hive.qa_case_status cs
       set ci_status = rc.status, ci_at = ${runAt}, ci_run_id = r.id, updated_at = now()
      from hive.qa_ci_run_cases rc
      join hive.qa_ci_runs r on r.id = rc.run_id
     where r.id = ${runId} and ${referenceRun} and cs.case_id = rc.case_id
       and (cs.ci_at is null or ${runAt} > cs.ci_at
            or (${runAt} = cs.ci_at and ${severitySql(sql`rc.status`)} > ${severitySql(sql`cs.ci_status`)}))`);
}

/**
 * Tính lại `ci_*` từ lịch sử: gửi lại cùng pipeline, đổi `reference_branch`, xoá nguồn, dọn dữ liệu. Gửi lại thì truyền
 * TC của cả bản cũ lẫn bản mới, vì TC biến mất khỏi báo cáo cũng phải lùi về lần chạy trước.
 */
export async function recomputeCiStatus(tx: Tx, projectId: string, caseIds?: readonly string[]): Promise<void> {
  if (caseIds?.length === 0) return;
  await tx.execute(sql`
    update hive.qa_case_status t
       set ci_status = l.status, ci_at = l.at, ci_run_id = l.run_id, updated_at = now()
      from (select cs.case_id, x.status, x.at, x.run_id
              from hive.qa_case_status cs
              left join lateral (
                select rc.status, ${runAt} as at, r.id as run_id
                  from hive.qa_ci_run_cases rc
                  join hive.qa_ci_runs r on r.id = rc.run_id
                 where rc.case_id = cs.case_id and ${referenceRun}
                 order by ${runAt} desc, ${severitySql(sql`rc.status`)} desc, r.id
                 limit 1) x on true
             where ${inScope(projectId, caseIds)}) l
     where t.case_id = l.case_id
       and (t.ci_status, t.ci_at, t.ci_run_id) is distinct from (l.status, l.at, l.run_id)`);
}

/**
 * Tính lại `manual_*` từ kết quả tay mới nhất có trạng thái tính (FR-052), ở mọi đợt. Lưu lại "Chưa test" đè lên
 * "Đạt" thì TC lùi về kết quả tính được trước đó thay vì mất kết quả.
 */
export async function recomputeManualStatus(tx: Tx, projectId: string, caseIds?: readonly string[]): Promise<void> {
  if (caseIds?.length === 0) return;
  await tx.execute(sql`
    update hive.qa_case_status t
       set manual_status = l.status, manual_at = l.at, manual_round_case_id = l.round_case_id, updated_at = now()
      from (select cs.case_id, x.status, x.at, x.round_case_id
              from hive.qa_case_status cs
              left join lateral (
                select rc.status, rc.recorded_at as at, rc.id as round_case_id
                  from hive.qa_round_cases rc
                 where rc.case_id = cs.case_id and rc.status in (${counted}) and rc.recorded_at is not null
                 order by rc.recorded_at desc, ${severitySql(sql`rc.status`)} desc, rc.id
                 limit 1) x on true
             where ${inScope(projectId, caseIds)}) l
     where t.case_id = l.case_id
       and (t.manual_status, t.manual_at, t.manual_round_case_id)
           is distinct from (l.status, l.at, l.round_case_id)`);
}

/** Cả hai phía, sau khi xoá nguồn hoặc dọn dữ liệu cũ. */
export async function recomputeCaseStatus(tx: Tx, projectId: string, caseIds?: readonly string[]): Promise<void> {
  await recomputeCiStatus(tx, projectId, caseIds);
  await recomputeManualStatus(tx, projectId, caseIds);
}
