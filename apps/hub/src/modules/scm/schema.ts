import { sql } from "drizzle-orm";
import { index, integer, pgPolicy, pgRole, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;

export const scmKind = hive.enum("scm_kind", ["github", "gitlab"]);
export const scmAuthMode = hive.enum("scm_auth_mode", ["app", "token"]);

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
      /**
       * GitHub: "app" (GitHub App) hoặc "token" (PAT). Mặc định "app" vì mọi kết nối GitHub có trước cột này đều là
       * App. GitLab ghi "token".
       */
      authMode: scmAuthMode("auth_mode").notNull().default("app"),
      // Không bí mật, để người quản trị nhận ra kết nối mà không phải giải mã.
      appId: text("app_id"),
      installationId: integer("installation_id"),
      /** JSON của secret (khoá riêng GitHub App, token GitHub hoặc token GitLab), mã hoá envelope với ngữ cảnh là id dòng. */
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
