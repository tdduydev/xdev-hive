import { sql } from "drizzle-orm";
import { index, integer, pgPolicy, pgRole, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

export const scmKind = hive.enum("scm_kind", ["github", "gitlab"]);

/**
 * Kết nối GitHub App hoặc GitLab của một tổ chức. Khoá ngoại tới orgs nằm trong migration viết tay, vì schema của
 * module không được import bảng của tenancy.
 */
export const scmConnections = hive
  .table(
    "scm_connections",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      kind: scmKind("kind").notNull(),
      name: text("name").notNull(),
      /** GitHub: API URL của GitHub Enterprise Server, null với github.com. GitLab: địa chỉ GitLab. */
      baseUrl: text("base_url"),
      /** GitHub: org đã cài App. GitLab: group hay dùng. Gợi ý sẵn khi tạo dự án. */
      defaultOwner: text("default_owner"),
      // Không bí mật, để người quản trị nhận ra kết nối mà không phải giải mã.
      appId: text("app_id"),
      installationId: integer("installation_id"),
      /** JSON của secret (khoá riêng GitHub App hoặc token GitLab), mã hoá envelope với ngữ cảnh là id dòng. */
      secretEnc: text("secret_enc").notNull(),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("scm_connections_org_name").on(t.orgId, t.name),
      // Khoá kép để bảng của module khác (projects) không trỏ được tới kết nối của tổ chức khác.
      unique("scm_connections_id_org").on(t.id, t.orgId),
      index("scm_connections_org").on(t.orgId),
      pgPolicy("scm_connections_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();

export const webhookDeliveryStatus = hive.enum("webhook_delivery_status", ["queued", "processed", "ignored", "failed"]);

/**
 * Mỗi lần GitHub/GitLab gọi webhook của một dự án. Mã giao nhận duy nhất theo nhà cung cấp: nhà cung cấp gửi lại
 * (timeout, bấm "Redeliver") thì INSERT đụng ràng buộc và request được trả 200 mà không xử lý lần nữa. Khoá ngoại tới
 * projects và orgs nằm trong migration viết tay, vì schema của module không được import bảng của module khác.
 */
export const webhookDeliveries = hive
  .table(
    "webhook_deliveries",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id").notNull(),
      provider: scmKind("provider").notNull(),
      deliveryId: text("delivery_id").notNull(),
      /** Tên sự kiện gốc kèm action, ví dụ `pull_request.closed`, `merge_request.merge`. */
      event: text("event").notNull(),
      receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
      processedAt: timestamp("processed_at", { withTimezone: true }),
      status: webhookDeliveryStatus("status").notNull(),
      error: text("error"),
    },
    (t) => [
      unique("webhook_deliveries_provider_delivery").on(t.provider, t.deliveryId),
      index("webhook_deliveries_org_project").on(t.orgId, t.projectId, t.receivedAt),
      pgPolicy("webhook_deliveries_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();
