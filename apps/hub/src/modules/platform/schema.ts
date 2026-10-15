import { sql } from "drizzle-orm";
import {
  bigint,
  check,
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
