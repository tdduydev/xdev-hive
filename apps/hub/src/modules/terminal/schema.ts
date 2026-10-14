import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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
  uuid,
} from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const scoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const terminalMode = hive.enum("terminal_mode", ["propose", "bypass"]);
export const terminalState = hive.enum("terminal_state", ["opening", "running", "closed", "failed"]);
export const terminalVisibility = hive.enum("terminal_visibility", ["private", "team"]);
/** `hub`: phiên Leader hub mở trên máy dùng chung; `local`: `hive chat` tại máy cá nhân; `remote`: mở từ điện thoại. */
export const terminalOrigin = hive.enum("terminal_origin", ["hub", "local", "remote"]);

/**
 * Phiên terminal tương tác: phiên Leader trên máy dùng chung (`hub`) và phiên trên máy cá nhân (`local`, `remote`,
 * specs/010 US1). Không dùng bảng runs: phiên do người gõ, không có lease, lần thử hay chính sách kết quả. Phiên Leader
 * luôn có dự án, chế độ và model; phiên máy cá nhân có thể không gắn dự án và model do CLI tại máy tự chọn.
 */
export const terminalSessions = hive
  .table(
    "terminal_sessions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      origin: terminalOrigin("origin").notNull().default("hub"),
      projectId: uuid("project_id"),
      /** Task người chạy `hive chat --task` gắn; hub bỏ liên kết khi task không thuộc dự án của đội máy (FR-030). */
      taskId: uuid("task_id"),
      machineId: uuid("machine_id").notNull(),
      ownerUserId: text("owner_user_id").notNull(),
      mode: terminalMode("mode"),
      cli: text("cli").notNull().default("claude"),
      model: text("model"),
      advisor: text("advisor"),
      accountId: text("account_id"),
      accountLabel: text("account_label"),
      /** Quyền worker thật sự áp (term_opened); null tới khi worker báo. */
      permissions: text("permissions"),
      threadId: uuid("thread_id"),
      planId: uuid("plan_id"),
      /** Nhãn thư mục worker gửi (nhãn root + thư mục con), không bao giờ là đường dẫn tuyệt đối. */
      cwdLabel: text("cwd_label"),
      /** Phiên máy cá nhân cho điều khiển từ xa (`--no-remote` hay máy đang tắt từ xa thì không). */
      remote: boolean("remote").notNull().default(false),
      /** `requestId` của `term_start` khi mở từ điện thoại, để hub ghép `term_opened`/`term_denied` với yêu cầu. */
      requestId: uuid("request_id"),
      state: terminalState("state").notNull().default("opening"),
      visibility: terminalVisibility("visibility").notNull().default("private"),
      cols: integer("cols").notNull(),
      rows: integer("rows").notNull(),
      /** Số byte output đã ghi (đã che bí mật) và seq output kế tiếp mong đợi từ worker. */
      bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
      nextSeq: integer("next_seq").notNull().default(0),
      exitCode: integer("exit_code"),
      endReason: text("end_reason"),
      lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      endedAt: timestamp("ended_at", { withTimezone: true }),
    },
    (t) => [
      unique("terminal_sessions_id_org").on(t.id, t.orgId),
      index("terminal_sessions_owner").on(t.orgId, t.ownerUserId, t.createdAt),
      index("terminal_sessions_project").on(t.projectId, t.createdAt),
      index("terminal_sessions_machine_state").on(t.machineId, t.state),
      index("terminal_sessions_task").on(t.taskId),
      check(
        "terminal_sessions_hub_fields",
        sql`${t.origin} <> 'hub' or (${t.projectId} is not null and ${t.mode} is not null and ${t.model} is not null)`,
      ),
      scoped("terminal_sessions"),
    ],
  )
  .enableRLS();

/** Bản ghi output của phiên đã che bí mật, theo seq của worker; chỉ chủ phiên (và đội khi "Cho đội xem") đọc. */
export const terminalChunks = hive
  .table(
    "terminal_chunks",
    {
      orgId: uuid("org_id").notNull(),
      sessionId: uuid("session_id").notNull(),
      seq: integer("seq").notNull(),
      data: bytea("data").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.sessionId, t.seq] }),
      foreignKey({
        columns: [t.sessionId, t.orgId],
        foreignColumns: [terminalSessions.id, terminalSessions.orgId],
      }).onDelete("cascade"),
      index("terminal_chunks_org").on(t.orgId),
      scoped("terminal_chunks"),
      // hive.purge_terminal_chunks (SECURITY DEFINER, chạy bằng hive_owner) xoá bản ghi quá số ngày giữ log của mọi tổ
      // chức, như run_logs; hive_app không được gì thêm.
      pgPolicy("terminal_chunks_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("terminal_chunks_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Dòng thời gian của phiên máy cá nhân cho audit và trang phiên: gắn/tách, cấp/thu quyền, nhập bị từ chối, sự kiện
 * worker (`attention`, `idle`). Không chứa phím gõ hay output.
 */
export const terminalEvents = hive
  .table(
    "terminal_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      sessionId: uuid("session_id").notNull(),
      /** seq output lúc xảy ra, để phát lại đặt được sự kiện đúng chỗ. */
      seq: integer("seq"),
      kind: text("kind").notNull(),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      actorUserId: text("actor_user_id"),
      deviceId: text("device_id"),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({
        columns: [t.sessionId, t.orgId],
        foreignColumns: [terminalSessions.id, terminalSessions.orgId],
      }).onDelete("cascade"),
      index("terminal_events_session").on(t.sessionId, t.at),
      index("terminal_events_org").on(t.orgId),
      scoped("terminal_events"),
    ],
  )
  .enableRLS();

/**
 * Bản sao danh sách thiết bị máy báo (`term_state`, `term_pair_result`) để trang Thiết bị hiện được khi máy offline.
 * Nguồn thật là `remote.json` trên máy: hub gỡ ở đây không gỡ được quyền, phải gửi `term_device_revoke`. Chỉ có khoá
 * công khai ở máy, hub không giữ khoá hay bí mật ghép.
 */
export const remoteDevices = hive
  .table(
    "remote_devices",
    {
      orgId: uuid("org_id").notNull(),
      machineId: uuid("machine_id").notNull(),
      /** Id worker sinh cho thiết bị, duy nhất trong một máy. */
      id: text("id").notNull(),
      userId: text("user_id").notNull(),
      label: text("label").notNull(),
      synced: boolean("synced").notNull().default(false),
      createdAt: timestamp("created_at", { withTimezone: true }),
      lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.machineId, t.id] }),
      index("remote_devices_org_user").on(t.orgId, t.userId),
      scoped("remote_devices"),
    ],
  )
  .enableRLS();

/** Đăng ký Web Push của trình duyệt (US7). `endpoint` duy nhất: trình duyệt đăng ký lại thì thay khoá cũ. */
export const pushSubscriptions = hive
  .table(
    "push_subscriptions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      userId: text("user_id").notNull(),
      endpoint: text("endpoint").notNull(),
      p256dh: text("p256dh").notNull(),
      auth: text("auth").notNull(),
      deviceLabel: text("device_label"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("push_subscriptions_org_endpoint").on(t.orgId, t.endpoint),
      index("push_subscriptions_org_user").on(t.orgId, t.userId),
      scoped("push_subscriptions"),
    ],
  )
  .enableRLS();

/**
 * Trạng thái từ xa máy báo lần gần nhất (`term_state`), để điện thoại thấy thư mục, CLI, tài khoản cả khi máy offline.
 * Chỉ là bản sao để hiển thị: worker tự kiểm mọi yêu cầu theo `remote.json` của nó.
 */
export const machineRemoteState = hive
  .table(
    "machine_remote_state",
    {
      machineId: uuid("machine_id").primaryKey(),
      orgId: uuid("org_id").notNull(),
      enabled: boolean("enabled").notNull().default(false),
      roots: jsonb("roots").$type<{ id: string; label: string }[]>().notNull().default([]),
      clis: jsonb("clis").$type<string[]>().notNull().default([]),
      accounts: jsonb("accounts")
        .$type<{ id: string; label: string; cli: string; state: string }[]>()
        .notNull()
        .default([]),
      totpEnabled: boolean("totp_enabled").notNull().default(false),
      totpLockedUntil: timestamp("totp_locked_until", { withTimezone: true }),
      confirmOnMachine: boolean("confirm_on_machine").notNull().default(false),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index("machine_remote_state_org").on(t.orgId), scoped("machine_remote_state")],
  )
  .enableRLS();
