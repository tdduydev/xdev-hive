import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
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
const inOrg = sql`org_id = hive.ctx_org()`;
const scoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const terminalMode = hive.enum("terminal_mode", ["propose", "bypass"]);
export const terminalState = hive.enum("terminal_state", ["opening", "running", "closed", "failed"]);
export const terminalVisibility = hive.enum("terminal_visibility", ["private", "team"]);

/**
 * Phiên terminal Leader (specs/010 lát máy dùng chung). Không dùng bảng runs: phiên do người gõ, không có lease, lần thử
 * hay chính sách kết quả. Phiên chỉ trỏ tới dự án, máy và cuộc trò chuyện leader chứa đề xuất của nó.
 */
export const terminalSessions = hive
  .table(
    "terminal_sessions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").notNull(),
      machineId: uuid("machine_id").notNull(),
      ownerUserId: text("owner_user_id").notNull(),
      mode: terminalMode("mode").notNull(),
      cli: text("cli").notNull().default("claude"),
      model: text("model").notNull(),
      advisor: text("advisor"),
      accountId: text("account_id"),
      accountLabel: text("account_label"),
      /** Quyền worker thật sự áp (term_opened); null tới khi worker báo. */
      permissions: text("permissions"),
      threadId: uuid("thread_id"),
      planId: uuid("plan_id"),
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
    ],
  )
  .enableRLS();
