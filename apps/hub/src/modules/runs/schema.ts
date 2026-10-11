import type { OutcomeCheck, RunResultView } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const runKind = hive.enum("run_kind", ["code", "review"]);
export const runState = hive.enum("run_state", [
  "queued",
  "planning",
  "awaiting_plan",
  "leased",
  "preparing",
  "running",
  "awaiting_input",
  "verifying",
  "succeeded",
  "no_changes",
  "needs_review",
  "failed",
  "lost",
  "cancelling",
  "cancelled",
]);

/** Phần result do hub ghi; ngoài phần hiện cho người xem còn giữ báo cáo thô của worker để tra lỗi. */
export type RunResult = RunResultView & { report?: Record<string, unknown> | null };

/**
 * Một lần giao task cho agent. Khoá ngoại tới tasks, projects, teams (bảng của module khác) nằm trong migration viết
 * tay. machine_id không có khoá ngoại: máy bị thu hồi vẫn giữ dòng, và run phải còn lịch sử kể cả khi máy bị xoá.
 */
export const runs = hive
  .table(
    "runs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      taskId: uuid("task_id").notNull(),
      projectId: uuid("project_id").notNull(),
      kind: runKind("kind").notNull().default("code"),
      state: runState("state").notNull().default("queued"),
      /** Lần thử hiện tại; gói của worker mang attempt khác bị từ chối (fencing). */
      attempt: integer("attempt").notNull().default(1),
      maxAttempts: integer("max_attempts").notNull().default(3),
      machineId: uuid("machine_id"),
      pinnedMachineId: uuid("pinned_machine_id"),
      cli: text("cli").$type<"claude" | "codex" | "gemini">(),
      model: text("model"),
      branch: text("branch").notNull(),
      /** Chính sách kết quả chốt lúc giao, để cấu hình dự án đổi sau không đổi kết quả của run. */
      policySnapshot: jsonb("policy_snapshot").$type<OutcomeCheck[]>().notNull(),
      result: jsonb("result").$type<RunResult>(),
      headSha: text("head_sha"),
      prUrl: text("pr_url"),
      timeoutSec: integer("timeout_sec").notNull().default(3600),
      /** Đề nghị job đang chờ máy trả lời; hết hạn thì hub đề nghị máy khác. */
      offerMachineId: uuid("offer_machine_id"),
      offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
      /** Máy đã từ chối trong lần thử hiện tại; xoá khi sang lần thử mới. */
      rejectedBy: uuid("rejected_by").array().notNull().default(sql`'{}'::uuid[]`),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("runs_id_org").on(t.id, t.orgId),
      // Mỗi task chỉ một run đang sống: hai người bấm giao cùng lúc thì người sau nhận lỗi trùng.
      uniqueIndex("runs_task_active")
        .on(t.taskId)
        .where(sql`state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`),
      index("runs_org_team").on(t.orgId, t.teamId),
      index("runs_team_state").on(t.teamId, t.state),
      index("runs_task").on(t.taskId),
      orgScoped("runs"),
    ],
  )
  .enableRLS();

/**
 * Nhật ký append-only của run: sự kiện worker gửi (seq của worker) và chuyển trạng thái do hub ghi (seq null). Loại
 * trùng theo (run_id, attempt, seq) vì worker gửi lại gói chưa được ack khi nối lại.
 */
export const runEvents = hive
  .table(
    "run_events",
    {
      id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
      orgId: uuid("org_id").notNull(),
      runId: uuid("run_id").notNull(),
      attempt: integer("attempt").notNull(),
      seq: integer("seq"),
      type: text("type").notNull(),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("run_events_seq").on(t.runId, t.attempt, t.seq),
      foreignKey({ columns: [t.runId, t.orgId], foreignColumns: [runs.id, runs.orgId] }).onDelete("cascade"),
      index("run_events_run").on(t.runId, t.id),
      index("run_events_org").on(t.orgId),
      // Chỉ đọc và thêm; UPDATE, DELETE bị thu quyền trong migration.
      pgPolicy("run_events_select", { for: "select", to: hiveApp, using: inOrg }),
      pgPolicy("run_events_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
    ],
  )
  .enableRLS();

/** Đoạn log terminal theo offset của từng lần thử. Hết run thì job gộp lên kho blob rồi xoá (chưa làm). */
export const runLogs = hive
  .table(
    "run_logs",
    {
      id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
      orgId: uuid("org_id").notNull(),
      runId: uuid("run_id").notNull(),
      attempt: integer("attempt").notNull(),
      seq: integer("seq").notNull(),
      offset: bigint("offset", { mode: "number" }).notNull(),
      data: bytea("data").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("run_logs_offset").on(t.runId, t.attempt, t.offset),
      foreignKey({ columns: [t.runId, t.orgId], foreignColumns: [runs.id, runs.orgId] }).onDelete("cascade"),
      index("run_logs_run").on(t.runId, t.id),
      index("run_logs_org").on(t.orgId),
      orgScoped("run_logs"),
    ],
  )
  .enableRLS();

/** Lease của máy trên một run: có hạn, gia hạn bằng heartbeat. Mỗi run nhiều nhất một lease. */
export const runLeases = hive
  .table(
    "run_leases",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      runId: uuid("run_id").notNull(),
      attempt: integer("attempt").notNull(),
      machineId: uuid("machine_id").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("run_leases_run").on(t.runId),
      foreignKey({ columns: [t.runId, t.orgId], foreignColumns: [runs.id, runs.orgId] }).onDelete("cascade"),
      index("run_leases_machine").on(t.machineId),
      index("run_leases_org_team").on(t.orgId, t.teamId),
      orgScoped("run_leases"),
    ],
  )
  .enableRLS();
