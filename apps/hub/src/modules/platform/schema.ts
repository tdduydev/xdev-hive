import { sql } from "drizzle-orm";
import {
  bigint,
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
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const blobs = hive
  .table(
    "blobs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      sha256: text("sha256").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      mediaType: text("media_type").notNull(),
      chunkCount: integer("chunk_count").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("blobs_org_sha256").on(t.orgId, t.sha256),
      unique("blobs_id_org").on(t.id, t.orgId),
      check("blobs_size", sql`size >= 0 and chunk_count >= 0`),
      check("blobs_sha256", sql`sha256 ~ '^[a-f0-9]{64}$'`),
      orgScoped("blobs"),
    ],
  )
  .enableRLS();

export const blobChunks = hive
  .table(
    "blob_chunks",
    {
      blobId: uuid("blob_id").notNull(),
      orgId: uuid("org_id").notNull(),
      ord: integer("ord").notNull(),
      data: bytea("data").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.blobId, t.ord] }),
      foreignKey({ columns: [t.blobId, t.orgId], foreignColumns: [blobs.id, blobs.orgId] }).onDelete("cascade"),
      check("blob_chunks_size", sql`ord >= 0 and octet_length(data) <= 524288`),
      index("blob_chunks_org").on(t.orgId),
      orgScoped("blob_chunks"),
    ],
  )
  .enableRLS();

export const clientSource = hive.enum("client_source", [
  "worker-run",
  "worker",
  "desktop",
  "hive-cli",
  "mcp-local",
  "vscode",
  "web",
  "unknown",
]);
export const clientEventOutcome = hive.enum("client_event_outcome", ["accepted", "rejected"]);

/**
 * Sự kiện client đã xử lý, một dòng mỗi khoá chống trùng (specs/027 US1, ADR 0036). Dòng `accepted` ghi cùng transaction
 * với thay đổi nghiệp vụ; gửi lại cùng khoá thì đọc dòng này, không làm lại. Giữ 30 ngày (≥ 14 ngày của hộp thư đi).
 */
export const clientEvents = hive
  .table(
    "client_events",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
      source: clientSource("source").notNull(),
      // Không khoá ngoại tới machines: platform không phụ thuộc fleet; máy bị xoá thì dòng vẫn giữ tới khi hết hạn.
      machineId: uuid("machine_id"),
      userId: text("user_id"),
      kind: text("kind").notNull(),
      targetType: text("target_type"),
      targetId: text("target_id"),
      clientCreatedAt: timestamp("client_created_at", { withTimezone: true }),
      receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
      outcome: clientEventOutcome("outcome").notNull(),
      reasonCode: text("reason_code"),
      reason: text("reason"),
      response: jsonb("response"),
    },
    (t) => [
      unique("client_events_org_key").on(t.orgId, t.idempotencyKey),
      index("client_events_target").on(t.orgId, t.targetType, t.targetId, t.receivedAt),
      index("client_events_received").on(t.receivedAt),
      orgScoped("client_events"),
      // Job dọn hằng ngày chạy hàm SECURITY DEFINER của hive_owner, không có tổ chức trong context; FORCE RLS áp cả cho
      // chủ bảng nên cần hai policy này. hive_app không được gì thêm.
      pgPolicy("client_events_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("client_events_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();
