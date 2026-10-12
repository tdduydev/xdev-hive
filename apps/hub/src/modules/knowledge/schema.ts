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
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

// RLS chỉ cắt theo tổ chức như các module khác; quyền theo đội (viewer đọc, member ghi, admin duyệt) kiểm trong
// code vì cần vai trò của người gọi, thứ RLS không biết.
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const memoryKind = hive.enum("memory_kind", ["decision", "convention", "gotcha", "note"]);
export const proposalKind = hive.enum("proposal_kind", ["doc", "skill"]);
export const proposalStatus = hive.enum("proposal_status", ["pending", "approved", "rejected"]);

// Phạm vi chung của mọi bảng tri thức: team_id null là cả tổ chức; project_id null là cả đội. Mục của dự án vẫn
// ghi team_id của đội sở hữu dự án để lọc theo đội không phải join sang projects. Khoá ngoại tới teams/projects
// (bảng của module khác) nằm trong migration viết tay.
const scopeColumns = () => ({
  orgId: uuid("org_id").notNull(),
  teamId: uuid("team_id"),
  projectId: uuid("project_id"),
});
const scopeCheck = (name: string) => check(`${name}_scope`, sql`project_id is null or team_id is not null`);

// Người viết là người dùng hoặc run của agent (khi gọi qua MCP), không bao giờ cả hai. Chưa có bảng runs nên
// author_run_id chưa có khoá ngoại.
const authorColumns = () => ({
  authorUserId: text("author_user_id"),
  authorRunId: uuid("author_run_id"),
});
const updatedByColumns = () => ({
  updatedByUserId: text("updated_by_user_id"),
  updatedByRunId: uuid("updated_by_run_id"),
});
const authorCheck = (name: string, prefix: string) =>
  check(name, sql.raw(`(${prefix}_user_id is null) <> (${prefix}_run_id is null)`));

/**
 * Memory ngắn của agent và người: quyết định, quy ước, bẫy đã gặp. Cột `search` sinh từ nội dung với cấu hình
 * 'simple' (không stemming, không bỏ dấu) vì Postgres không có từ điển tiếng Việt. Cột `embedding` (pgvector)
 * không khai báo ở đây: migration chỉ thêm khi database có extension vector, xem 0014.
 */
export const memories = hive
  .table(
    "memories",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      kind: memoryKind("kind").notNull(),
      status: text("status").notNull().default("approved"),
      content: text("content").notNull(),
      files: text("files").array().notNull().default(sql`'{}'::text[]`),
      ...authorColumns(),
      /** Mô hình đã tạo embedding; chỉ so vector cùng mô hình (cùng số chiều, cùng không gian). */
      embeddingModel: text("embedding_model"),
      supersededBy: uuid("superseded_by"),
      search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content)`),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("memories_content_len", sql`char_length(content) between 1 and 2000`),
      check("memories_status", sql`status in ('approved', 'pending')`),
      scopeCheck("memories"),
      authorCheck("memories_author", "author"),
      foreignKey({ columns: [t.supersededBy], foreignColumns: [t.id] }).onDelete("set null"),
      index("memories_scope").on(t.orgId, t.teamId, t.projectId, t.createdAt.desc()),
      index("memories_search").using("gin", t.search),
      orgScoped("memories"),
    ],
  )
  .enableRLS();

/** Tài liệu markdown theo key. Nội dung nằm ở doc_versions; dòng này giữ phiên bản hiện tại để khoá lạc quan. */
export const docs = hive
  .table(
    "docs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      key: text("key").notNull(),
      title: text("title").notNull(),
      currentVersion: integer("current_version").notNull(),
      ...updatedByColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("docs_org_key").on(t.orgId, t.key),
      unique("docs_id_org").on(t.id, t.orgId),
      scopeCheck("docs"),
      authorCheck("docs_updated_by", "updated_by"),
      index("docs_scope").on(t.orgId, t.teamId, t.projectId),
      orgScoped("docs"),
    ],
  )
  .enableRLS();

/** Mỗi lần lưu một dòng, không sửa không xoá: lịch sử và nguồn để đối chiếu khi duyệt đề xuất. */
export const docVersions = hive
  .table(
    "doc_versions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      docId: uuid("doc_id").notNull(),
      version: integer("version").notNull(),
      title: text("title").notNull(),
      content: text("content").notNull(),
      message: text("message"),
      proposalId: uuid("proposal_id"),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("doc_versions_doc_version").on(t.docId, t.version),
      foreignKey({ columns: [t.docId, t.orgId], foreignColumns: [docs.id, docs.orgId] }).onDelete("cascade"),
      authorCheck("doc_versions_author", "author"),
      index("doc_versions_org").on(t.orgId),
      orgScoped("doc_versions"),
    ],
  )
  .enableRLS();

/** Skill (nội dung SKILL.md). Tên duy nhất trong một phạm vi; phạm vi hẹp hơn che skill cùng tên ở phạm vi rộng. */
export const skills = hive
  .table(
    "skills",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      name: text("name").notNull(),
      description: text("description").notNull(),
      currentVersion: integer("current_version").notNull(),
      /** Đường dẫn SKILL.md trong kho skill Git (ADR 0014); null khi skill mới chỉ có trên hub. */
      repoPath: text("repo_path"),
      /** Phiên bản đang khớp với Git; khác current_version là skill đã sửa trên hub, chờ đẩy lên Git. */
      repoVersion: integer("repo_version"),
      ...updatedByColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      // NULLS NOT DISTINCT: hai skill cùng tên ở cấp tổ chức (team_id, project_id đều null) vẫn tính là trùng.
      unique("skills_scope_name").on(t.orgId, t.teamId, t.projectId, t.name).nullsNotDistinct(),
      unique("skills_id_org").on(t.id, t.orgId),
      scopeCheck("skills"),
      authorCheck("skills_updated_by", "updated_by"),
      orgScoped("skills"),
    ],
  )
  .enableRLS();

export const skillVersions = hive
  .table(
    "skill_versions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      skillId: uuid("skill_id").notNull(),
      version: integer("version").notNull(),
      description: text("description").notNull(),
      content: text("content").notNull(),
      message: text("message"),
      proposalId: uuid("proposal_id"),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("skill_versions_skill_version").on(t.skillId, t.version),
      foreignKey({ columns: [t.skillId, t.orgId], foreignColumns: [skills.id, skills.orgId] }).onDelete("cascade"),
      authorCheck("skill_versions_author", "author"),
      index("skill_versions_org").on(t.orgId),
      orgScoped("skill_versions"),
    ],
  )
  .enableRLS();

/**
 * Đề xuất sửa tài liệu hoặc skill, chờ quản trị đội duyệt. Giữ nguyên nội dung đề xuất và base_version: duyệt thì
 * lưu như một lần save với base đó, nên tài liệu đã đổi sau khi đề xuất sẽ báo xung đột thay vì bị ghi đè.
 */
export const proposals = hive
  .table(
    "proposals",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      kind: proposalKind("kind").notNull(),
      /** Key tài liệu hoặc tên skill. */
      target: text("target").notNull(),
      baseVersion: integer("base_version").notNull(),
      title: text("title"),
      description: text("description"),
      content: text("content").notNull(),
      reason: text("reason"),
      status: proposalStatus("status").notNull().default("pending"),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      decidedBy: text("decided_by"),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
      decisionNote: text("decision_note"),
      resultVersion: integer("result_version"),
      /** PR mở trong kho skill Git cho đề xuất skill (SKILL-04); duyệt hoặc từ chối trên hub thì đóng PR. */
      gitPrNumber: integer("git_pr_number"),
      gitPrUrl: text("git_pr_url"),
    },
    (t) => [
      scopeCheck("proposals"),
      authorCheck("proposals_author", "author"),
      index("proposals_org_status").on(t.orgId, t.status, t.createdAt.desc()),
      orgScoped("proposals"),
    ],
  )
  .enableRLS();

/** Một nguồn hub cũ cho mỗi tổ chức; lưu cả id nguồn và id đích để chia memory mà vẫn loại trùng nguyên bản. */
export const legacyImports = hive
  .table(
    "legacy_imports",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      kind: text("kind").notNull(),
      sourceId: text("source_id").notNull(),
      targetIds: uuid("target_ids").array().notNull(),
      metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("legacy_imports_source").on(t.orgId, t.kind, t.sourceId),
      unique("legacy_imports_id_org").on(t.id, t.orgId),
      check("legacy_imports_kind", sql`kind in ('memory', 'doc', 'skill', 'asset')`),
      orgScoped("legacy_imports"),
    ],
  )
  .enableRLS();

/** Giữ locator SeaweedFS để chuyển blob sau; tuyệt đối không coi metadata là một tệp đã tải lên. */
export const legacyDocAssets = hive
  .table(
    "legacy_doc_assets",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      documentImportId: uuid("document_import_id").notNull(),
      sourceId: text("source_id").notNull(),
      name: text("name").notNull(),
      mediaType: text("media_type").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      sha256: text("sha256"),
      storageLocator: text("storage_locator"),
      status: text("status").notNull().default("missing"),
      uploadedBy: text("uploaded_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      unique("legacy_doc_assets_source").on(t.orgId, t.sourceId),
      foreignKey({
        columns: [t.documentImportId, t.orgId],
        foreignColumns: [legacyImports.id, legacyImports.orgId],
      }).onDelete("cascade"),
      check("legacy_doc_assets_status", sql`status in ('missing', 'available')`),
      check("legacy_doc_assets_size", sql`size >= 0`),
      index("legacy_doc_assets_document").on(t.documentImportId, t.orgId),
      orgScoped("legacy_doc_assets"),
    ],
  )
  .enableRLS();

export const skillRepoStatus = hive.enum("skill_repo_status", ["idle", "syncing", "ok", "failed"]);

/**
 * Kho skill Git của tổ chức (specs/006-skills-repo-sync). Mỗi tổ chức một kho; `id` nằm trong đường dẫn webhook
 * /hooks/skills/{id}. Webhook đến không có phiên nên chưa biết tổ chức: hub đặt id vào app.webhook_skill_repo_id và
 * policy cho thấy đúng dòng đó (như ctx_webhook_project của dự án).
 */
export const skillRepos = hive
  .table(
    "skill_repos",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      /** Kết nối Git trong module scm; không khoá ngoại sang module khác, kiểm khi cấu hình. */
      connectionId: uuid("connection_id").notNull(),
      owner: text("owner").notNull(),
      name: text("name").notNull(),
      branch: text("branch").notNull(),
      webhookSecretEnc: text("webhook_secret_enc").notNull(),
      webhookId: text("webhook_id"),
      webhookUrl: text("webhook_url"),
      status: skillRepoStatus("status").notNull().default("idle"),
      lastSha: text("last_sha"),
      lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
      error: text("error"),
      /** Người cấu hình kho: là tác giả của phiên bản skill đồng bộ từ Git (bảng phiên bản đòi một tác giả). */
      configuredBy: text("configured_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("skill_repos_org").on(t.orgId),
      pgPolicy("skill_repos_rw", { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg }),
      pgPolicy("skill_repos_webhook", {
        for: "select",
        to: hiveApp,
        using: sql`id = hive.ctx_webhook_skill_repo()`,
      }),
    ],
  )
  .enableRLS();
