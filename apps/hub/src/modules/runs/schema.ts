import type { OutcomeCheck, RunExplore, RunResultView, RunRtk, RunTokenGuard } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
const hiveOwner = pgRole("hive_owner").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const runKind = hive.enum("run_kind", [
  "code",
  "review",
  "plan",
  "leader",
  "doccheck",
  "docassist",
  "brief",
  "skill_proposal",
]);
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
 * Một lần giao việc cho agent. Run leader có thread/project nhưng không gắn task; khoá ngoại tới các bảng module khác
 * nằm trong migration viết tay. machine_id không có khoá ngoại để giữ lịch sử sau khi máy bị xoá.
 */
export const runs = hive
  .table(
    "runs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      taskId: uuid("task_id"),
      projectId: uuid("project_id").notNull(),
      leaderThreadId: uuid("leader_thread_id"),
      kind: runKind("kind").notNull().default("code"),
      /**
       * Run review chéo và run lập kế hoạch trỏ tới run code chúng phục vụ; cùng task, cùng tổ chức (khoá kép như các
       * bảng con).
       */
      parentRunId: uuid("parent_run_id"),
      state: runState("state").notNull().default("queued"),
      /** Lần thử hiện tại; gói của worker mang attempt khác bị từ chối (fencing). */
      attempt: integer("attempt").notNull().default(1),
      maxAttempts: integer("max_attempts").notNull().default(3),
      machineId: uuid("machine_id"),
      pinnedMachineId: uuid("pinned_machine_id"),
      cli: text("cli").$type<"claude" | "codex" | "gemini" | "antigravity">(),
      model: text("model"),
      /** Cấp độ task do người đặt tay (light|medium|heavy); null là hub suy từ task (routing.ts). */
      tier: text("tier").$type<"light" | "medium" | "heavy">(),
      branch: text("branch").notNull(),
      /** Chính sách kết quả chốt lúc giao, để cấu hình dự án đổi sau không đổi kết quả của run. */
      policySnapshot: jsonb("policy_snapshot").$type<OutcomeCheck[]>().notNull(),
      /**
       * Chính sách agent của tổ chức đã áp cho lần thử đang giao (model, quyền CLI, sandbox, trần, hook). Ghi lúc đề nghị
       * job; null với run giao trước khi có chính sách.
       */
      agentPolicySnapshot: jsonb("agent_policy_snapshot").$type<Record<string, unknown>>(),
      result: jsonb("result").$type<RunResult>(),
      headSha: text("head_sha"),
      prUrl: text("pr_url"),
      timeoutSec: integer("timeout_sec").notNull().default(3600),
      /**
       * Token và chi phí luỹ kế qua mọi lần thử, cộng từ sự kiện cost của worker và chỉ tăng. cost_usd null khi CLI
       * chưa báo USD lần nào (Codex, Gemini); numeric để cộng dồn không lệch như số thực.
       */
      tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
      tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
      cacheRead: bigint("cache_read", { mode: "number" }).notNull().default(0),
      cacheWrite: bigint("cache_write", { mode: "number" }).notNull().default(0),
      costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }),
      turns: integer("turns"),
      /**
       * Id gói (tài khoản CLI trên máy) đã chạy run, theo sự kiện cost của worker; lần thử sau ghi đè lần trước. null
       * khi dùng đăng nhập mặc định hoặc worker cũ chưa báo. Id chỉ có nghĩa trong một máy (accounts.json), nên thống kê
       * theo gói của dự án gộp các máy dùng cùng id.
       */
      accountId: text("account_id"),
      /**
       * Khảo sát trước lần sửa file đầu tiên của lần thử gần nhất (ADR 0022), worker báo trong sự kiện cost. null khi
       * CLI không báo được; lần thử mới ghi đè vì số so sánh trước/sau là của một phiên agent.
       */
      explore: jsonb("explore").$type<RunExplore & { attempt: number }>(),
      /**
       * Token RTK tiết kiệm được ở lần thử gần nhất, worker báo trong sự kiện cost. null khi run không dùng RTK; lần
       * thử mới ghi đè vì số luỹ kế là của một phiên agent.
       */
      rtk: jsonb("rtk").$type<RunRtk & { attempt: number }>(),
      /**
       * Context pack, lệnh khảo sát bị chặn và ký tự output đã cắt ở lần thử gần nhất (worker báo trong sự kiện cost).
       * null khi run không dùng; lần thử mới ghi đè như rtk.
       */
      tokenGuard: jsonb("token_guard").$type<RunTokenGuard & { attempt: number }>(),
      /** Đề nghị job đang chờ máy trả lời; hết hạn thì hub đề nghị máy khác. */
      offerMachineId: uuid("offer_machine_id"),
      offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
      /** Máy đã từ chối trong lần thử hiện tại; xoá khi sang lần thử mới. */
      rejectedBy: uuid("rejected_by").array().notNull().default(sql`'{}'::uuid[]`),
      createdBy: text("created_by").notNull(),
      /**
       * Người mà máy cá nhân của họ được chạy run này (ADR 0017). null là run của đội (Leader, gate AI, webhook): chỉ máy
       * dùng chung hoặc runner host nhận.
       */
      ownerUserId: text("owner_user_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("runs_id_org").on(t.id, t.orgId),
      // Mỗi task chỉ một run code đang sống: hai người bấm giao cùng lúc thì người sau nhận lỗi trùng. Run review
      // chạy trong lúc run cha còn verifying nên không tính.
      uniqueIndex("runs_task_active")
        .on(t.taskId)
        .where(sql`kind = 'code' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`),
      // Lọc theo leader_thread_id (chỉ run leader có) thay cho kind = 'leader': migration thêm giá trị enum 'leader' trong
      // cùng transaction, mà Postgres cấm dùng giá trị enum chưa commit (55P04) khi nâng cấp database đã có run_kind.
      uniqueIndex("runs_leader_thread_active")
        .on(t.leaderThreadId)
        .where(
          sql`leader_thread_id is not null and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`,
        ),
      // Hai lần verify (hay lập kế hoạch) chạy chồng nhau của run cha không tạo được hai run con cùng sống.
      uniqueIndex("runs_review_active")
        .on(t.parentRunId)
        .where(sql`state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`),
      // Mỗi dự án một run brief đang sống. Lọc theo branch thay cho kind = 'brief' vì cùng lý do 55P04 như trên.
      uniqueIndex("runs_brief_active")
        .on(t.projectId)
        .where(
          sql`branch like 'brief/%' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled')`,
        ),
      foreignKey({ columns: [t.parentRunId, t.orgId], foreignColumns: [t.id, t.orgId] }).onDelete("cascade"),
      index("runs_org_team").on(t.orgId, t.teamId),
      index("runs_team_state").on(t.teamId, t.state),
      index("runs_task").on(t.taskId),
      // costs.summary lọc theo dự án và khoảng ngày.
      index("runs_project_created").on(t.projectId, t.createdAt),
      // runs.search: mới nhất trước (quét ngược index), phân trang theo (created_at, id).
      index("runs_org_created").on(t.orgId, t.createdAt, t.id),
      // Ô lọc theo máy của runs.search hỏi từng máy có run của đội nào; team_id trong index để khỏi đọc bảng.
      index("runs_machine").on(t.machineId, t.teamId),
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
      // hive.purge_run_logs (SECURITY DEFINER, chạy bằng hive_owner) xoá log quá hạn giữ của mọi tổ chức; hive_app không
      // được gì thêm.
      pgPolicy("run_logs_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("run_logs_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
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
