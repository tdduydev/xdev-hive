import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Khoá ngoại tới projects, docs, users nằm trong migration viết tay như các module khác. Khoá ngoại ghép
// `ON DELETE SET NULL (<cột>)` cũng vậy, vì drizzle không sinh được dạng chỉ đặt null một cột: đặt null cả `org_id`
// thì vỡ `not null`.

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const identity = () => ({ id: uuid("id").primaryKey().defaultRandom(), orgId: uuid("org_id").notNull() });
const at = (name: string) => timestamp(name, { withTimezone: true });
const times = () => ({
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});
// `jsonb_array_length` lỗi khi gặp giá trị không phải mảng, nên kiểm kiểu trước trong `case`.
const jsonArray = (column: string, min: number, max: number) =>
  sql.raw(`case when jsonb_typeof(${column}) = 'array' then jsonb_array_length(${column}) between ${min} and ${max}
    else false end`);
// Đường dẫn tương đối trong repo: không bắt đầu bằng `/`, không có đoạn `..`.
const relativePath = (column: string) => sql.raw(`${column} !~ '^/' and ${column} !~ '(^|/)\\.\\.(/|$)'`);

// Mã spec hoặc mã SRS của research D10, ghép mảng bằng dấu phẩy để kiểm từng mã trong một regex. Postgres không cho
// subquery trong check, nên không duyệt `unnest` được.
const SPEC_CODE = String.raw`(\d{3}/)?(FR|AC|NFR|US)-\d{3,4}(\.\d+)?`;
const SRS_CODE = String.raw`(?!(FR|AC|NFR|US)(\d|,|$))[A-Z][A-Z0-9]{2,15}`;
const REQUIREMENT = `(${SPEC_CODE}|${SRS_CODE})`;

// ---- Thư viện ------------------------------------------------------------------------------------------------------

/** Cài đặt của tổ chức. Không có dòng thì dùng mặc định. */
export const qaSettings = hive
  .table(
    "qa_settings",
    {
      orgId: uuid("org_id").primaryKey(),
      retentionDays: integer("retention_days").notNull().default(365),
      updatedBy: text("updated_by"),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    (t) => [
      check("qa_settings_retention_days", sql`${t.retentionDays} BETWEEN 90 AND 3650`),
      pgPolicy("qa_settings_select", { for: "select", to: hiveApp, using: inOrg }),
      pgPolicy("qa_settings_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
      pgPolicy("qa_settings_update", { for: "update", to: hiveApp, using: inOrg, withCheck: inOrg }),
      // Hàm giữ dữ liệu chạy bằng hive_owner, đọc thời hạn của mọi tổ chức.
      pgPolicy("qa_settings_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

export const qaProjectSettings = hive
  .table(
    "qa_project_settings",
    {
      projectId: uuid("project_id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      enabled: boolean("enabled").notNull().default(false),
      /** Tính từ `doc_homes.root` (research D3b). */
      tcDir: text("tc_dir").notNull().default("test-cases/"),
      /** Kết quả `ensureProjectInclude` lần bật gần nhất. */
      includeResult: text("include_result"),
      updatedBy: text("updated_by"),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    () => [
      check(
        "qa_project_settings_tc_dir",
        sql`char_length(tc_dir) between 1 and 200 and tc_dir ~ '/$' and ${relativePath("tc_dir")}`,
      ),
      check(
        "qa_project_settings_include_result",
        sql`include_result is null or include_result in ('no-home', 'covered', 'added')`,
      ),
      orgScoped("qa_project_settings"),
    ],
  )
  .enableRLS();

/** Một dòng mỗi file khu. Mã khu là định danh: đổi mã là khu mới. */
export const qaAreas = hive
  .table(
    "qa_areas",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      code: text("code").notNull(),
      name: text("name").notNull(),
      docId: uuid("doc_id"),
      /** Giữ khi tài liệu bị xoá để còn biết khu từng ở file nào. */
      docKey: text("doc_key").notNull(),
      /** Phiên bản tài liệu của bộ TC đang áp dụng; file lỗi không đổi cột này (FR-004). */
      parsedVersion: integer("parsed_version"),
      parseErrors: jsonb("parse_errors").$type<Array<{ line: number; message: string }>>().notNull().default([]),
      errorsVersion: integer("errors_version"),
      archivedAt: at("archived_at"),
      ...times(),
    },
    (t) => [
      unique("qa_areas_id_org").on(t.id, t.orgId),
      unique("qa_areas_project_code").on(t.projectId, t.code),
      uniqueIndex("qa_areas_doc").on(t.docId).where(sql`doc_id is not null`),
      check("qa_areas_code", sql`code ~ '^[A-Z][A-Z0-9]{1,15}$'`),
      check("qa_areas_parse_errors", jsonArray("parse_errors", 0, 100)),
      orgScoped("qa_areas"),
    ],
  )
  .enableRLS();

/** Một dòng mỗi mã TC từng có trong dự án. Không xoá dòng, nên mã không bị cấp lại (FR-006). */
export const qaCases = hive
  .table(
    "qa_cases",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      areaId: uuid("area_id").notNull(),
      code: text("code").notNull(),
      name: text("name").notNull(),
      priority: text("priority").notNull(),
      kind: text("kind").notNull(),
      requirements: text("requirements").array().notNull(),
      labels: text("labels").array().notNull().default(sql`'{}'`),
      preconditions: text("preconditions"),
      steps: jsonb("steps").$type<Array<{ n: number; action: string; expected: string }>>().notNull(),
      testData: text("test_data"),
      script: text("script"),
      note: text("note"),
      /** Dòng `###` trong file, để mở editor đúng chỗ. */
      line: integer("line").notNull(),
      version: integer("version").notNull().default(1),
      /** Băm các trường của FR-002; đổi thì tăng `version`. */
      contentHash: text("content_hash").notNull(),
      state: text("state").notNull().default("active"),
      retiredAt: at("retired_at"),
      ...times(),
    },
    (t) => [
      unique("qa_cases_id_org").on(t.id, t.orgId),
      unique("qa_cases_project_code").on(t.projectId, t.code),
      foreignKey({ columns: [t.areaId, t.orgId], foreignColumns: [qaAreas.id, qaAreas.orgId] }).onDelete("cascade"),
      index("qa_cases_project_area_state").on(t.projectId, t.areaId, t.state),
      index("qa_cases_requirements").using("gin", t.requirements),
      index("qa_cases_labels").using("gin", t.labels),
      check("qa_cases_code", sql`code ~ '^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$'`),
      check("qa_cases_name", sql`char_length(name) between 1 and 300`),
      check("qa_cases_priority", sql`priority in ('P1', 'P2', 'P3')`),
      check("qa_cases_kind", sql`kind in ('automated', 'manual', 'planned')`),
      check(
        "qa_cases_requirements",
        sql.raw(
          `cardinality(requirements) >= 1 and array_to_string(requirements, ',') ~ '^${REQUIREMENT}(,${REQUIREMENT})*$'`,
        ),
      ),
      check("qa_cases_labels", sql`cardinality(labels) <= 20 and array_to_string(labels, ',') !~ '\\s'`),
      check("qa_cases_steps", jsonArray("steps", 1, 1000)),
      check("qa_cases_script", sql`kind <> 'automated' or script is not null`),
      check("qa_cases_version", sql`version >= 1`),
      check("qa_cases_state", sql`state in ('active', 'retired')`),
      orgScoped("qa_cases"),
    ],
  )
  .enableRLS();

/** Bản chụp nội dung mỗi phiên bản, để so "TC đã đổi sau khi giao" (FR-037). */
export const qaCaseVersions = hive
  .table(
    "qa_case_versions",
    {
      caseId: uuid("case_id").notNull(),
      version: integer("version").notNull(),
      orgId: uuid("org_id").notNull(),
      content: jsonb("content").notNull(),
      docVersion: integer("doc_version").notNull(),
      createdAt: at("created_at").notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.caseId, t.version] }),
      foreignKey({ columns: [t.caseId, t.orgId], foreignColumns: [qaCases.id, qaCases.orgId] }).onDelete("cascade"),
      orgScoped("qa_case_versions"),
    ],
  )
  .enableRLS();

// Luật FR-052: một phía có giá trị thì lấy phía đó; hai phía thì bên mới hơn thắng, bằng giờ thì kết quả tay thắng.
const manualWins = "manual_status is not null and (ci_status is null or ci_at <= manual_at)";

/** Bảng chiếu trạng thái hiện tại, một dòng mỗi TC (research D12). */
export const qaCaseStatus = hive
  .table(
    "qa_case_status",
    {
      caseId: uuid("case_id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id").notNull(),
      areaId: uuid("area_id").notNull(),
      ciStatus: text("ci_status"),
      ciAt: at("ci_at"),
      ciRunId: uuid("ci_run_id"),
      manualStatus: text("manual_status"),
      manualAt: at("manual_at"),
      manualRoundCaseId: uuid("manual_round_case_id"),
      currentStatus: text("current_status").generatedAlwaysAs(
        sql.raw(`case when ${manualWins} then manual_status else ci_status end`),
      ),
      currentSource: text("current_source").generatedAlwaysAs(
        sql.raw(`case when ${manualWins} then 'manual' when ci_status is not null then 'ci' end`),
      ),
      updatedAt: at("updated_at").notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.caseId, t.orgId], foreignColumns: [qaCases.id, qaCases.orgId] }).onDelete("cascade"),
      index("qa_case_status_project_current").on(t.projectId, t.currentStatus),
      index("qa_case_status_project_area").on(t.projectId, t.areaId),
      check("qa_case_status_ci", sql`ci_status is null or ci_status in ('passed', 'flaky', 'failed', 'skipped')`),
      check("qa_case_status_manual", sql`manual_status is null or manual_status in ('passed', 'failed', 'other')`),
      // So thời điểm chỉ đúng khi trạng thái nào cũng có mốc giờ.
      check("qa_case_status_ci_at", sql`(ci_status is null) = (ci_at is null)`),
      check("qa_case_status_manual_at", sql`(manual_status is null) = (manual_at is null)`),
      orgScoped("qa_case_status"),
    ],
  )
  .enableRLS();

// ---- CI ------------------------------------------------------------------------------------------------------------

/** Nguồn kết quả CI của dự án (FR-020). */
export const qaCiSources = hive
  .table(
    "qa_ci_sources",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      label: text("label").notNull(),
      /** So với `ScmEvent.repo`. */
      repoPath: text("repo_path").notNull(),
      /** Gốc để dựng liên kết pipeline và job; worker không gửi URL (FR-026). */
      repoWebUrl: text("repo_web_url").notNull(),
      branchFilter: text("branch_filter").array().notNull().default(sql`'{}'`),
      jobFilter: text("job_filter").array().notNull().default(sql`'{}'`),
      mode: text("mode").notNull(),
      artifactPath: text("artifact_path"),
      referenceBranch: text("reference_branch").notNull(),
      /** Tên credential GitLab trong kho tại máy (`credentialRef` của specs/032). */
      credential: text("credential").notNull(),
      backfillState: text("backfill_state").notNull().default("pending"),
      refetchRequestedAt: at("refetch_requested_at"),
      createdBy: text("created_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("qa_ci_sources_id_org").on(t.id, t.orgId),
      unique("qa_ci_sources_project_label").on(t.projectId, t.label),
      index("qa_ci_sources_project_repo").on(t.projectId, t.repoPath),
      check("qa_ci_sources_label", sql`char_length(label) between 1 and 80`),
      check("qa_ci_sources_repo_web_url", sql`repo_web_url ~ '^https://'`),
      check("qa_ci_sources_mode", sql`mode in ('pipeline-report', 'junit-artifact', 'playwright-artifact')`),
      check(
        "qa_ci_sources_artifact_path",
        sql`(mode = 'pipeline-report' or artifact_path is not null)
          and (artifact_path is null or (char_length(artifact_path) >= 1 and ${relativePath("artifact_path")}))`,
      ),
      check("qa_ci_sources_backfill_state", sql`backfill_state in ('pending', 'listing', 'done', 'error')`),
      orgScoped("qa_ci_sources"),
    ],
  )
  .enableRLS();

/**
 * Một dòng mỗi pipeline của một nguồn (FR-024, FR-027). Không có cột tên test, thông báo lỗi hay URL do worker gửi
 * (FR-025, FR-026). `delivery_job_id` chưa có khoá ngoại: đợi specs/032 T011 (T062).
 */
export const qaCiRuns = hive
  .table(
    "qa_ci_runs",
    {
      ...identity(),
      sourceId: uuid("source_id").notNull(),
      pipelineId: bigint("pipeline_id", { mode: "number" }).notNull(),
      readState: text("read_state").notNull().default("waiting"),
      deliveryJobId: uuid("delivery_job_id"),
      readAttempts: integer("read_attempts").notNull().default(0),
      /** Mốc tính 24 giờ chờ máy (FR-022). */
      waitingSince: at("waiting_since"),
      waitReason: text("wait_reason"),
      readErrorCode: text("read_error_code"),
      pipelineStatus: text("pipeline_status").notNull(),
      ref: text("ref").notNull(),
      sha: text("sha").notNull(),
      kind: text("kind").notNull(),
      isReference: boolean("is_reference").notNull().default(false),
      startedAt: at("started_at"),
      finishedAt: at("finished_at"),
      jobIds: bigint("job_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
      passed: integer("passed").notNull().default(0),
      flaky: integer("flaky").notNull().default(0),
      failed: integer("failed").notNull().default(0),
      skipped: integer("skipped").notNull().default(0),
      unmapped: integer("unmapped").notNull().default(0),
      ambiguous: integer("ambiguous").notNull().default(0),
      unknownCodes: text("unknown_codes").array().notNull().default(sql`'{}'`),
      retiredCodes: integer("retired_codes").notNull().default(0),
      truncated: boolean("truncated").notNull().default(false),
      receivedAt: at("received_at"),
      ...times(),
    },
    (t) => [
      unique("qa_ci_runs_id_org").on(t.id, t.orgId),
      unique("qa_ci_runs_source_pipeline").on(t.sourceId, t.pipelineId),
      foreignKey({ columns: [t.sourceId, t.orgId], foreignColumns: [qaCiSources.id, qaCiSources.orgId] }).onDelete(
        "cascade",
      ),
      index("qa_ci_runs_source_reference").on(t.sourceId, t.isReference, t.finishedAt.desc()),
      index("qa_ci_runs_org_read_state").on(t.orgId, t.readState),
      check(
        "qa_ci_runs_read_state",
        sql`read_state in ('waiting', 'reading', 'done', 'no-report', 'error', 'expired')`,
      ),
      check("qa_ci_runs_read_attempts", sql`read_attempts >= 0`),
      check(
        "qa_ci_runs_pipeline_status",
        sql`pipeline_status in ('success', 'failed', 'canceled', 'skipped', 'manual')`,
      ),
      check("qa_ci_runs_sha", sql`sha ~ '^[0-9a-f]{40}$'`),
      check("qa_ci_runs_kind", sql`kind in ('branch', 'mr')`),
      check("qa_ci_runs_unknown_codes", sql`cardinality(unknown_codes) <= 200`),
      check(
        "qa_ci_runs_counts",
        sql`passed >= 0 and flaky >= 0 and failed >= 0 and skipped >= 0 and unmapped >= 0 and ambiguous >= 0
          and retired_codes >= 0`,
      ),
      orgScoped("qa_ci_runs"),
    ],
  )
  .enableRLS();

/** Một dòng mỗi TC của một lần chạy (FR-024). */
export const qaCiRunCases = hive
  .table(
    "qa_ci_run_cases",
    {
      runId: uuid("run_id").notNull(),
      caseId: uuid("case_id").notNull(),
      orgId: uuid("org_id").notNull(),
      /** Chép từ `qa_cases`: mã TC gắn cố định một khu nên không lệch, gộp theo khu khỏi phải join. */
      areaId: uuid("area_id").notNull(),
      status: text("status").notNull(),
      retries: integer("retries").notNull().default(0),
      durationMs: integer("duration_ms").notNull().default(0),
      worstJobId: bigint("worst_job_id", { mode: "number" }),
    },
    (t) => [
      primaryKey({ columns: [t.runId, t.caseId] }),
      foreignKey({ columns: [t.runId, t.orgId], foreignColumns: [qaCiRuns.id, qaCiRuns.orgId] }).onDelete("cascade"),
      foreignKey({ columns: [t.caseId, t.orgId], foreignColumns: [qaCases.id, qaCases.orgId] }).onDelete("cascade"),
      index("qa_ci_run_cases_case_run").on(t.caseId, t.runId),
      check("qa_ci_run_cases_status", sql`status in ('passed', 'flaky', 'failed', 'skipped')`),
      check("qa_ci_run_cases_numbers", sql`retries >= 0 and duration_ms >= 0`),
      orgScoped("qa_ci_run_cases"),
    ],
  )
  .enableRLS();

// ---- Đợt test ------------------------------------------------------------------------------------------------------

export const qaRounds = hive
  .table(
    "qa_rounds",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      name: text("name").notNull(),
      environment: text("environment").notNull().default(""),
      build: text("build").notNull().default(""),
      startDate: date("start_date").notNull(),
      plannedEndDate: date("planned_end_date").notNull(),
      state: text("state").notNull().default("open"),
      /** Đợt gốc khi tạo đợt tiếp theo (FR-038). */
      previousRoundId: uuid("previous_round_id"),
      reopenReason: text("reopen_reason"),
      /** Mọi người có `qa.record` ở đội của dự án ghi được, không cần được giao (FR-010). */
      openRecording: boolean("open_recording").notNull().default(false),
      createdBy: text("created_by").notNull(),
      closedAt: at("closed_at"),
      ...times(),
    },
    (t) => [
      unique("qa_rounds_id_org").on(t.id, t.orgId),
      index("qa_rounds_project_state").on(t.projectId, t.state),
      check("qa_rounds_name", sql`char_length(name) between 1 and 120`),
      check("qa_rounds_environment", sql`char_length(environment) <= 80`),
      check("qa_rounds_build", sql`char_length(build) <= 80`),
      check("qa_rounds_dates", sql`planned_end_date >= start_date`),
      check("qa_rounds_state", sql`state in ('open', 'closed')`),
      check("qa_rounds_reopen_reason", sql`reopen_reason is null or char_length(reopen_reason) between 10 and 500`),
      orgScoped("qa_rounds"),
    ],
  )
  .enableRLS();

const ROUND_STATUS = sql.raw(`('passed', 'failed', 'untested', 'not-applicable', 'deferred', 'other')`);
// Không có subquery trong check, nên kiểm từng phần tử theo chỉ số; mảng tối đa 5 phần tử nên đủ.
const linksOk = sql.raw(
  `cardinality(links) <= 5 and ${[1, 2, 3, 4, 5]
    .map(
      (i) => `(cardinality(links) < ${i} or (links[${i}] ~* '^https?://\\S+$' and char_length(links[${i}]) <= 2000))`,
    )
    .join(" and ")}`,
);
// Không đạt hoặc Khác phải có lý do (FR-033).
const explained = sql.raw(
  `status not in ('other', 'failed') or coalesce(char_length(note), 0) > 0 or cardinality(links) > 0`,
);

/** Một dòng mỗi TC trong một đợt, giữ kết quả tay hiện tại (research D13). */
export const qaRoundCases = hive
  .table(
    "qa_round_cases",
    {
      ...identity(),
      roundId: uuid("round_id").notNull(),
      caseId: uuid("case_id").notNull(),
      /** `qa_cases.version` lúc thêm vào đợt, để biết TC đã đổi sau khi giao (FR-037). */
      caseVersionAtAdd: integer("case_version_at_add").notNull(),
      status: text("status").notNull().default("untested"),
      /** Check không đọc được số bước ở `qa_cases`, nên hub kiểm "≤ số bước" lúc lưu. */
      failedStep: integer("failed_step"),
      note: text("note"),
      links: text("links").array().notNull().default(sql`'{}'`),
      recordedBy: text("recorded_by"),
      recordedAt: at("recorded_at"),
      recordedCaseVersion: integer("recorded_case_version"),
      /** Khoá lạc quan (FR-035). */
      revision: integer("revision").notNull().default(0),
    },
    (t) => [
      unique("qa_round_cases_id_org").on(t.id, t.orgId),
      unique("qa_round_cases_round_case").on(t.roundId, t.caseId),
      foreignKey({ columns: [t.roundId, t.orgId], foreignColumns: [qaRounds.id, qaRounds.orgId] }).onDelete("cascade"),
      foreignKey({ columns: [t.caseId, t.orgId], foreignColumns: [qaCases.id, qaCases.orgId] }).onDelete("cascade"),
      index("qa_round_cases_case_recorded").on(t.caseId, t.recordedAt.desc()),
      check("qa_round_cases_status", sql`status in ${ROUND_STATUS}`),
      check("qa_round_cases_failed_step", sql`failed_step is null or failed_step >= 1`),
      check("qa_round_cases_note", sql`note is null or char_length(note) <= 500`),
      check("qa_round_cases_links", linksOk),
      check("qa_round_cases_explained", explained),
      check("qa_round_cases_revision", sql`revision >= 0`),
      orgScoped("qa_round_cases"),
    ],
  )
  .enableRLS();

export const qaRoundAssignees = hive
  .table(
    "qa_round_assignees",
    {
      roundCaseId: uuid("round_case_id").notNull(),
      userId: text("user_id").notNull(),
      orgId: uuid("org_id").notNull(),
      assignedBy: text("assigned_by").notNull(),
      assignedAt: at("assigned_at").notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.roundCaseId, t.userId] }),
      foreignKey({
        columns: [t.roundCaseId, t.orgId],
        foreignColumns: [qaRoundCases.id, qaRoundCases.orgId],
      }).onDelete("cascade"),
      // "Việc của tôi" (FR-032).
      index("qa_round_assignees_user").on(t.userId),
      orgScoped("qa_round_assignees"),
    ],
  )
  .enableRLS();

/** Bản cũ của kết quả tay trước mỗi lần lưu (FR-034). */
export const qaResultHistory = hive
  .table(
    "qa_result_history",
    {
      roundCaseId: uuid("round_case_id").notNull(),
      revision: integer("revision").notNull(),
      orgId: uuid("org_id").notNull(),
      status: text("status").notNull(),
      failedStep: integer("failed_step"),
      note: text("note"),
      links: text("links").array().notNull().default(sql`'{}'`),
      recordedBy: text("recorded_by"),
      recordedAt: at("recorded_at"),
      recordedCaseVersion: integer("recorded_case_version"),
      /** Admin đã xoá ghi chú: `note` thành null nhưng vẫn biết từng có. */
      noteDeleted: boolean("note_deleted").notNull().default(false),
      changedBy: text("changed_by").notNull(),
      changedAt: at("changed_at").notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.roundCaseId, t.revision] }),
      foreignKey({
        columns: [t.roundCaseId, t.orgId],
        foreignColumns: [qaRoundCases.id, qaRoundCases.orgId],
      }).onDelete("cascade"),
      check("qa_result_history_status", sql`status in ${ROUND_STATUS}`),
      check("qa_result_history_note_deleted", sql`not note_deleted or note is null`),
      orgScoped("qa_result_history"),
    ],
  )
  .enableRLS();
