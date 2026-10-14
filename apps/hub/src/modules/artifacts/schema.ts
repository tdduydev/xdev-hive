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

// Khai báo lại schema và role thay vì lấy từ module khác: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const artifactType = hive.enum("artifact_type", [
  "markdown",
  "code",
  "html",
  "react",
  "svg",
  "mermaid",
  "csv",
  "json",
  "image",
  "pdf",
]);
export const artifactScope = hive.enum("artifact_scope", ["private", "project", "team", "org"]);
export const artifactOrigin = hive.enum("artifact_origin", ["leader", "terminal", "run", "mcp", "manual"]);
export const artifactLinkKind = hive.enum("artifact_link_kind", [
  "chat_thread",
  "terminal_session",
  "run",
  "task",
  "sdlc_item",
  "doc",
]);

/**
 * Artifact: một sản phẩm agent hoặc người tạo ra (trang HTML, tài liệu, sơ đồ…). Nội dung nằm ở `artifact_versions`.
 * Khoá ngoại tới teams/projects không khai báo: dự án bị xoá thì artifact của nó vẫn còn cho chủ đọc, không cascade.
 * `origin_project_id` chỉ gợi ý nơi chia sẻ, không cấp quyền.
 */
export const artifacts = hive
  .table(
    "artifacts",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      scope: artifactScope("scope").notNull().default("private"),
      teamId: uuid("team_id"),
      projectId: uuid("project_id"),
      originProjectId: uuid("origin_project_id"),
      ownerUserId: text("owner_user_id").notNull(),
      title: text("title").notNull(),
      type: artifactType("type").notNull(),
      /** Ngôn ngữ của loại `code`. */
      language: text("language"),
      origin: artifactOrigin("origin").notNull(),
      latestVersion: integer("latest_version").notNull().default(1),
      // Không khoá ngoại: bản gốc có thể bị xoá hẳn mà bản nhân vẫn giữ dòng "Nhân bản từ …".
      duplicatedFromId: uuid("duplicated_from_id"),
      duplicatedFromVersion: integer("duplicated_from_version"),
      /** Tổng cỡ các phiên bản, kể cả bản biên dịch; dung lượng tổ chức = sum cột này (cả thùng rác). */
      sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
      /** Hub cập nhật khi lưu: tiêu đề + 200 000 ký tự đầu, cấu hình `simple`. */
      search: tsvector("search"),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
      deletedBy: text("deleted_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("artifacts_id_org").on(t.id, t.orgId),
      check("artifacts_title_len", sql`char_length(title) between 1 and 200`),
      check("artifacts_project_scope", sql`(scope = 'project') = (project_id is not null)`),
      check("artifacts_team_scope", sql`scope not in ('project', 'team') or team_id is not null`),
      check("artifacts_team_only_scoped", sql`scope in ('project', 'team') or team_id is null`),
      index("artifacts_org_updated").on(t.orgId, t.updatedAt.desc()).where(sql`deleted_at is null`),
      index("artifacts_org_owner").on(t.orgId, t.ownerUserId),
      index("artifacts_org_project").on(t.orgId, t.projectId),
      // Thùng rác: job xoá hẳn quét theo deleted_at.
      index("artifacts_deleted_at").on(t.deletedAt).where(sql`deleted_at is not null`),
      index("artifacts_search").using("gin", t.search),
      orgScoped("artifacts"),
      // hive.artifact_purge (SECURITY DEFINER, chạy bằng hive_owner) xoá hẳn artifact trong thùng rác của mọi tổ chức.
      pgPolicy("artifacts_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("artifacts_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Phiên bản chỉ thêm, không sửa: `hive_app` chỉ có select + insert (migration thu hồi UPDATE/DELETE), nên lịch sử bất
 * biến bằng quyền database chứ không chỉ bằng code. Hai thay đổi duy nhất đi qua hàm SECURITY DEFINER
 * `hive.artifact_tombstone` và `hive.artifact_version_rename`; dòng chỉ mất khi xoá hẳn artifact (cascade).
 */
export const artifactVersions = hive
  .table(
    "artifact_versions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      artifactId: uuid("artifact_id").notNull(),
      version: integer("version").notNull(),
      /** Null khi là blob hoặc đã tombstone. */
      content: text("content"),
      /** Blob lưu ở bảng sau MVP (T062), chưa có khoá ngoại. */
      blobId: uuid("blob_id"),
      /** `react`: mã đã biên dịch hoặc lỗi biên dịch. */
      compiled: text("compiled"),
      compileError: text("compile_error"),
      sha256: text("sha256").notNull(),
      sizeBytes: integer("size_bytes").notNull(),
      authorUserId: text("author_user_id"),
      authorRunId: uuid("author_run_id"),
      origin: artifactOrigin("origin").notNull(),
      message: text("message"),
      name: text("name"),
      restoredFrom: integer("restored_from"),
      tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
      tombstonedBy: text("tombstoned_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("artifact_versions_artifact_version").on(t.artifactId, t.version),
      foreignKey({ columns: [t.artifactId, t.orgId], foreignColumns: [artifacts.id, artifacts.orgId] }).onDelete(
        "cascade",
      ),
      check("artifact_versions_author", sql`(author_user_id is null) <> (author_run_id is null)`),
      check("artifact_versions_message_len", sql`char_length(message) <= 500`),
      check("artifact_versions_name_len", sql`char_length(name) <= 80`),
      // Giới hạn số phiên bản của một run đếm theo author_run_id.
      index("artifact_versions_author_run").on(t.authorRunId).where(sql`author_run_id is not null`),
      pgPolicy("artifact_versions_select", { for: "select", to: hiveApp, using: inOrg }),
      pgPolicy("artifact_versions_insert", { for: "insert", to: hiveApp, withCheck: inOrg }),
      // Hai hàm SECURITY DEFINER tự kiểm org_id = ctx_org(); owner không có quyền đọc hay sửa tổ chức khác.
      pgPolicy("artifact_versions_owner_select", { for: "select", to: hiveOwner, using: inOrg }),
      pgPolicy("artifact_versions_owner_update", { for: "update", to: hiveOwner, using: inOrg, withCheck: inOrg }),
    ],
  )
  .enableRLS();

/** Artifact gắn với chat, terminal, run, task… `target_id` đa hình nên không có khoá ngoại; job purge dọn liên kết mồ côi. */
export const artifactLinks = hive
  .table(
    "artifact_links",
    {
      orgId: uuid("org_id").notNull(),
      artifactId: uuid("artifact_id").notNull(),
      targetKind: artifactLinkKind("target_kind").notNull(),
      targetId: uuid("target_id").notNull(),
      createdByUserId: text("created_by_user_id"),
      createdByRunId: uuid("created_by_run_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.artifactId, t.targetKind, t.targetId] }),
      foreignKey({ columns: [t.artifactId, t.orgId], foreignColumns: [artifacts.id, artifacts.orgId] }).onDelete(
        "cascade",
      ),
      index("artifact_links_target").on(t.orgId, t.targetKind, t.targetId),
      orgScoped("artifact_links"),
    ],
  )
  .enableRLS();

/** Bản xem trước chưa lưu của một người (preview trong khung cách ly); hết hạn thì job purge xoá. */
export const artifactPreviews = hive
  .table(
    "artifact_previews",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      userId: text("user_id").notNull(),
      type: artifactType("type").notNull(),
      content: text("content").notNull(),
      compiled: text("compiled"),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      index("artifact_previews_expires").on(t.expiresAt),
      index("artifact_previews_org_user").on(t.orgId, t.userId),
      orgScoped("artifact_previews"),
      pgPolicy("artifact_previews_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("artifact_previews_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Link công khai ghim một phiên bản. Mã không bao giờ được lưu, chỉ `token_sha256`. Người xem không đăng nhập nên chưa có
 * tổ chức trong context: `hive.artifact_public_link_resolve` (SECURITY DEFINER) đổi băm thành (org_id, link_id).
 */
export const artifactPublicLinks = hive
  .table(
    "artifact_public_links",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      artifactId: uuid("artifact_id").notNull(),
      version: integer("version").notNull(),
      tokenSha256: text("token_sha256").notNull().unique(),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedBy: text("revoked_by"),
      revokeReason: text("revoke_reason"),
      viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
      lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    },
    (t) => [
      check("artifact_public_links_expiry", sql`expires_at > created_at`),
      check(
        "artifact_public_links_revoke_reason",
        sql`revoke_reason in ('manual', 'deleted', 'owner_changed', 'tombstoned', 'owner_left', 'org_disabled')`,
      ),
      foreignKey({ columns: [t.artifactId, t.orgId], foreignColumns: [artifacts.id, artifacts.orgId] }).onDelete(
        "cascade",
      ),
      index("artifact_public_links_active").on(t.orgId, t.artifactId).where(sql`revoked_at is null`),
      index("artifact_public_links_expires").on(t.orgId, t.expiresAt).where(sql`revoked_at is null`),
      orgScoped("artifact_public_links"),
      // resolve và purge chạy bằng hive_owner, không có tổ chức trong context.
      pgPolicy("artifact_public_links_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("artifact_public_links_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();
