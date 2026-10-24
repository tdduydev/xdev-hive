import { sql } from "drizzle-orm";
import { boolean, check, pgPolicy, pgRole, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

/**
 * Mốc của database: đổi mỗi khi khôi phục từ bản sao lưu hoặc PITR (specs/027 R7). Worker so mốc trong health với mốc
 * đã thấy để gửi lại kết quả hub đã nhận sau `restored_to` mà bản khôi phục không còn.
 * Bảng hệ thống một dòng, không thuộc tổ chức: hive_app chỉ đọc; chỉ script khôi phục (postgres) mới ghi.
 */
export const dbEpoch = hive
  .table(
    "db_epoch",
    {
      id: boolean("id").primaryKey().default(true),
      epoch: uuid("epoch").notNull().defaultRandom(),
      restoredTo: timestamp("restored_to", { withTimezone: true }),
      changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      check("db_epoch_single_row", sql`id`),
      pgPolicy("db_epoch_read", { for: "select", to: hiveApp, using: sql`true` }),
    ],
  )
  .enableRLS();
