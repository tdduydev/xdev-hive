import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
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
      status: machineStatus("status").notNull().default("offline"),
      /** Khoá công khai máy gửi lúc đăng ký (mục 6). Chưa dùng tới khi có access token ngắn hạn. */
      publicKey: text("public_key"),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
      offlineNotifiedAt: timestamp("offline_notified_at", { withTimezone: true }),
      /** Người tạo mã đăng ký mà máy đã dùng. */
      registeredBy: text("registered_by"),
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
