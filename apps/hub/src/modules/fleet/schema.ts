import type { WorkerAccountSummary } from "@xdev-hive/contracts/worker-protocol";
import { sql } from "drizzle-orm";
import {
  boolean,
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
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "../tenancy/index.ts";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
// Worker và người cài máy không có phiên người dùng, nên chưa biết tổ chức. Cho tìm đúng một dòng theo băm của token
// (giống invitations dùng ctx_invite). Chỉ mở SELECT; mọi thao tác ghi vẫn phải có tổ chức trong context.
const byToken = sql`org_id = hive.ctx_org() or token_hash = hive.ctx_fleet_token()`;

const tokenPolicies = (name: string) => [
  pgPolicy(`${name}_select`, { for: "select", to: hiveApp, using: byToken }),
  pgPolicy(`${name}_insert`, { for: "insert", to: hiveApp, withCheck: inOrg }),
  pgPolicy(`${name}_update`, { for: "update", to: hiveApp, using: inOrg, withCheck: inOrg }),
  pgPolicy(`${name}_delete`, { for: "delete", to: hiveApp, using: inOrg }),
];

export const machineKind = hive.enum("machine_kind", ["worker", "host"]);

export const machineStatus = hive.enum("machine_status", ["online", "offline", "revoked"]);

export const machines = hive
  .table(
    "machines",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      /** Định danh máy tự chọn (machineId trong gói hello). */
      name: text("name").notNull(),
      kind: machineKind("kind").notNull().default("worker"),
      os: text("os").notNull(),
      version: text("version").notNull(),
      clis: text("clis").array().notNull().default(sql`'{}'::text[]`),
      capacity: integer("capacity").notNull().default(1),
      /** Việc ngoài run code mà worker khai làm được trong hello (vd. `doccheck`). */
      capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
      /**
       * Dự án máy đã gắn với repo trên máy và dự án máy cho toàn quyền, worker báo trong hello và heartbeat (ADR 0020).
       * Worker cũ không báo: rỗng, như máy chưa gắn dự án nào.
       */
      boundProjects: text("bound_projects").array().notNull().default(sql`'{}'::text[]`),
      fullProjects: text("full_projects").array().notNull().default(sql`'{}'::text[]`),
      status: machineStatus("status").notNull().default("offline"),
      pausedAt: timestamp("paused_at", { withTimezone: true }),
      /** Khoá công khai máy gửi lúc đăng ký (mục 6). Chưa dùng tới khi có access token ngắn hạn. */
      publicKey: text("public_key"),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
      offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
      /** Người tạo mã đăng ký mà máy đã dùng. */
      registeredBy: text("registered_by"),
      /**
       * Máy dùng chung của đội (quản trị đội bật): nhận run của đội và của mọi thành viên. Mặc định là máy cá nhân, chỉ
       * nhận run của người đã đăng ký máy, vì CLI trên máy đăng nhập bằng tài khoản (gói thuê bao) của chính họ.
       */
      shared: boolean("shared").notNull().default(false),
      /** Nhãn máy (specs/011 FR-041): chỉ hub đặt, để máy không tự nhận nhãn để lấy việc. */
      labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
      /** Chỉ nhận run có ít nhất một nhãn của máy. */
      labelsOnly: boolean("labels_only").notNull().default(false),
      /**
       * Tóm tắt tài khoản CLI từ heartbeat (specs/011 FR-043): không token, không email. null khi worker chưa báo; heartbeat
       * thiếu trường thì giữ giá trị cũ.
       */
      accounts: jsonb("accounts").$type<WorkerAccountSummary[]>(),
      accountsAt: timestamp("accounts_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      // Theo tổ chức chứ không theo đội: hello chỉ mang tên máy, và tên trùng giữa hai đội dễ gây nhầm khi giao job.
      unique("machines_org_name").on(t.orgId, t.name),
      // Khoá kép để machine_tokens không trỏ được tới máy của tổ chức khác.
      unique("machines_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      index("machines_team").on(t.teamId),
      pgPolicy("machines_rw", { as: "permissive", for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();

/** Token lâu dài của máy. Chỉ lưu băm; thu hồi bằng cách xoá dòng. */
export const machineTokens = hive
  .table(
    "machine_tokens",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      machineId: uuid("machine_id").notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.machineId, t.orgId], foreignColumns: [machines.id, machines.orgId] }).onDelete(
        "cascade",
      ),
      index("machine_tokens_machine").on(t.machineId),
      index("machine_tokens_team").on(t.teamId),
      ...tokenPolicies("machine_tokens"),
    ],
  )
  .enableRLS();

/** Mã đăng ký máy: dùng một lần, hết hạn sau 1 giờ. Chỉ lưu băm; mã gốc chỉ hiện một lần cho admin đội. */
export const registrationTokens = hive
  .table(
    "registration_tokens",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      kind: machineKind("kind").notNull().default("worker"),
      /** Máy đăng ký bằng mã này nhận sẵn nhãn và cờ (specs/011 FR-042), để lệnh cài một dòng không cần cờ mới. */
      labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
      shared: boolean("shared").notNull().default(false),
      labelsOnly: boolean("labels_only").notNull().default(false),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      /** Máy đã dùng mã này (không có khoá ngoại để giữ dấu vết cả khi máy bị xoá). */
      usedByMachine: uuid("used_by_machine"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      index("registration_tokens_team").on(t.teamId),
      ...tokenPolicies("registration_tokens"),
    ],
  )
  .enableRLS();

/**
 * Mã đổi của đăng nhập app desktop bằng trình duyệt (contracts/desktop-connect.ts). Chỉ giữ băm của mã và PKCE
 * challenge, không giữ token nào: lúc app đổi mã, hub mới tạo mã đăng ký máy và token cá nhân, sau khi kiểm lại quyền.
 */
export const desktopConnectCodes = hive
  .table(
    "desktop_connect_codes",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      userId: text("user_id").notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      challenge: text("challenge").notNull(),
      machine: text("machine").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      ...tokenPolicies("desktop_connect_codes"),
    ],
  )
  .enableRLS();
