import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const identity = () => ({ id: uuid("id").primaryKey().defaultRandom(), orgId: uuid("org_id").notNull() });
const times = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
const strings = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const docHomes = hive
  .table(
    "doc_homes",
    {
      ...identity(),
      scope: text("scope").notNull(),
      projectId: uuid("project_id"),
      connectionId: uuid("connection_id").notNull(),
      owner: text("owner").notNull(),
      name: text("name").notNull(),
      branch: text("branch").notNull(),
      root: text("root").notNull().default("docs/"),
      assetsDir: text("assets_dir").notNull().default("assets"),
      mode: text("mode").notNull().default("pr"),
      include: strings("include"),
      exclude: strings("exclude"),
      repoChangesNeedReview: boolean("repo_changes_need_review").notNull().default(false),
      /** Mặc định của ô "Tài liệu mật" khi nhập Word vào nhà này (Q15). */
      wordImportConfidential: boolean("word_import_confidential").notNull().default(false),
      lastCommit: text("last_commit"),
      status: text("status").notNull().default("active"),
      statusReason: text("status_reason"),
      error: text("error"),
      webhookSecretEnc: text("webhook_secret_enc"),
      webhookId: text("webhook_id"),
      prNumber: integer("pr_number"),
      prUrl: text("pr_url"),
      lfsPatterns: strings("lfs_patterns"),
      configuredBy: text("configured_by").notNull(),
      // pg-boss giữ job đầu; hai mốc bền giúp push hẹn lại theo lần lưu cuối mà vẫn giữ trần chờ 10 phút.
      firstQueuedAt: timestamp("first_queued_at", { withTimezone: true }),
      lastSavedAt: timestamp("last_saved_at", { withTimezone: true }),
      ...times(),
    },
    (t) => [
      unique("doc_homes_id_org").on(t.id, t.orgId),
      uniqueIndex("doc_homes_project").on(t.orgId, t.projectId).where(sql`scope = 'project'`),
      uniqueIndex("doc_homes_org").on(t.orgId).where(sql`scope = 'org'`),
      check(
        "doc_homes_scope",
        sql`(scope = 'project' and project_id is not null) or (scope = 'org' and project_id is null)`,
      ),
      check("doc_homes_mode", sql`mode in ('pr', 'direct', 'off')`),
      check("doc_homes_status", sql`status in ('active', 'paused', 'error')`),
      index("doc_homes_connection").on(t.orgId, t.connectionId),
      orgScoped("doc_homes"),
      // Webhook đến không có phiên nên chưa biết tổ chức; xem ctx_webhook_doc_home trong migration.
      pgPolicy("doc_homes_webhook", { for: "select", to: hiveApp, using: sql`id = hive.ctx_webhook_doc_home()` }),
      // hive.docsync_active_orgs (SECURITY DEFINER, chạy bằng hive_owner) tìm tổ chức có nhà cần kéo theo cron.
      pgPolicy("doc_homes_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

export const docRepoFiles = hive
  .table(
    "doc_repo_files",
    {
      ...identity(),
      docId: uuid("doc_id").notNull(),
      homeId: uuid("home_id").notNull(),
      repoPath: text("repo_path").notNull(),
      syncedVersion: integer("synced_version"),
      syncedCommit: text("synced_commit"),
      syncedHash: text("synced_hash"),
      repoHash: text("repo_hash"),
      state: text("state").notNull().default("pending"),
      eol: text("eol").notNull().default("lf"),
      bom: boolean("bom").notNull().default(false),
      error: text("error"),
      ...times(),
    },
    (t) => [
      unique("doc_repo_files_home_path").on(t.homeId, t.repoPath),
      unique("doc_repo_files_doc").on(t.docId),
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      check(
        "doc_repo_files_state",
        sql`state in ('synced', 'pending', 'conflict', 'failed', 'deleted_in_repo', 'blocked_secret', 'excluded')`,
      ),
      check("doc_repo_files_eol", sql`eol in ('lf', 'crlf')`),
      index("doc_repo_files_pending").on(t.orgId, t.homeId, t.state),
      orgScoped("doc_repo_files"),
    ],
  )
  .enableRLS();

export const docSyncBatches = hive
  .table(
    "doc_sync_batches",
    {
      ...identity(),
      homeId: uuid("home_id").notNull(),
      mode: text("mode").notNull(),
      branch: text("branch").notNull(),
      docVersions: jsonb("doc_versions").$type<Array<{ docId: string; version: number }>>().notNull().default([]),
      assetIds: uuid("asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
      commitSha: text("commit_sha"),
      prNumber: integer("pr_number"),
      attempts: integer("attempts").notNull().default(0),
      nextAt: timestamp("next_at", { withTimezone: true }),
      state: text("state").notNull().default("queued"),
      error: text("error"),
      ...times(),
    },
    (t) => [
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      check("doc_sync_batches_mode", sql`mode in ('pr', 'direct')`),
      check("doc_sync_batches_state", sql`state in ('queued', 'pushing', 'done', 'failed')`),
      check("doc_sync_batches_attempts", sql`attempts >= 0`),
      index("doc_sync_batches_home_state").on(t.orgId, t.homeId, t.state),
      orgScoped("doc_sync_batches"),
    ],
  )
  .enableRLS();

export const docConflicts = hive
  .table(
    "doc_conflicts",
    {
      ...identity(),
      homeId: uuid("home_id").notNull(),
      docId: uuid("doc_id").notNull(),
      baseVersion: integer("base_version").notNull(),
      hubVersion: integer("hub_version").notNull(),
      /** Bên kia của xung đột: `repo` (kéo từ repo) hoặc `word` (cập nhật từ Word, P2). */
      origin: text("origin").notNull().default("repo"),
      /** null khi bên kia là Word: bản mới chưa nằm trong commit nào. */
      repoCommit: text("repo_commit"),
      repoContent: text("repo_content").notNull(),
      /** Gốc của Word là Markdown của lần nhập trước, không phải một phiên bản hub, nên phải lưu riêng. */
      baseContent: text("base_content"),
      state: text("state").notNull().default("open"),
      resolution: text("resolution"),
      resolvedBy: text("resolved_by"),
      resolvedVersion: integer("resolved_version"),
      ...times(),
    },
    (t) => [
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      uniqueIndex("doc_conflicts_open").on(t.docId).where(sql`state = 'open'`),
      check("doc_conflicts_state", sql`state in ('open', 'resolved')`),
      check("doc_conflicts_resolution", sql`resolution is null or resolution in ('hub', 'repo', 'manual')`),
      check(
        "doc_conflicts_origin",
        sql`(origin = 'repo' and repo_commit is not null) or (origin = 'word' and base_content is not null)`,
      ),
      index("doc_conflicts_org_state").on(t.orgId, t.state),
      orgScoped("doc_conflicts"),
    ],
  )
  .enableRLS();

export const docImports = hive
  .table(
    "doc_imports",
    {
      ...identity(),
      homeId: uuid("home_id").notNull(),
      commitSha: text("commit_sha"),
      include: strings("include"),
      exclude: strings("exclude"),
      preview: jsonb("preview").$type<Record<string, unknown>>().notNull().default({}),
      selected: jsonb("selected").$type<unknown[]>().notNull().default([]),
      state: text("state").notNull().default("scanning"),
      progress: jsonb("progress")
        .$type<{ done: number; total: number; cursor: string | null }>()
        .notNull()
        .default({ done: 0, total: 0, cursor: null }),
      report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
      error: text("error"),
      startedBy: text("started_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("doc_imports_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      check("doc_imports_state", sql`state in ('scanning', 'ready', 'importing', 'done', 'failed', 'cancelled')`),
      index("doc_imports_home").on(t.orgId, t.homeId, t.createdAt),
      orgScoped("doc_imports"),
    ],
  )
  .enableRLS();

export const docAssets = hive
  .table(
    "doc_assets",
    {
      ...identity(),
      homeId: uuid("home_id").notNull(),
      repoPath: text("repo_path").notNull(),
      blobId: uuid("blob_id"),
      mediaType: text("media_type").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      sha256: text("sha256").notNull(),
      lfs: boolean("lfs").notNull().default(false),
      state: text("state").notNull().default("available"),
      ownerDocId: uuid("owner_doc_id"),
      ...times(),
    },
    (t) => [
      unique("doc_assets_id_org").on(t.id, t.orgId),
      unique("doc_assets_home_path").on(t.homeId, t.repoPath),
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      // pending_delete: ảnh không còn tài liệu nào trỏ tới sau khi cập nhật từ Word, lô đẩy kế tiếp xoá khỏi repo (P2).
      check(
        "doc_assets_state",
        sql`state in ('available', 'missing_lfs', 'too_large', 'pending_push', 'pending_delete')`,
      ),
      check("doc_assets_size", sql`size >= 0`),
      check("doc_assets_blob", sql`state not in ('available', 'pending_push') or blob_id is not null`),
      index("doc_assets_blob").on(t.orgId, t.blobId),
      orgScoped("doc_assets"),
    ],
  )
  .enableRLS();

export const docExtracts = hive
  .table(
    "doc_extracts",
    {
      ...identity(),
      assetId: uuid("asset_id").notNull(),
      sourceSha256: text("source_sha256").notNull(),
      content: text("content").notNull().default(""),
      state: text("state").notNull().default("pending"),
      error: text("error"),
      secretFlag: boolean("secret_flag").notNull().default(false),
      warnings: strings("warnings"),
      reviewedBy: text("reviewed_by"),
      reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
      ...times(),
    },
    (t) => [
      unique("doc_extracts_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.assetId, t.orgId], foreignColumns: [docAssets.id, docAssets.orgId] }).onDelete(
        "cascade",
      ),
      uniqueIndex("doc_extracts_approved").on(t.assetId).where(sql`state = 'approved'`),
      check("doc_extracts_state", sql`state in ('pending', 'review', 'approved', 'rejected', 'failed')`),
      index("doc_extracts_org_state").on(t.orgId, t.state),
      orgScoped("doc_extracts"),
    ],
  )
  .enableRLS();

export const docImportFiles = hive
  .table(
    "doc_import_files",
    {
      ...identity(),
      importId: uuid("import_id").notNull(),
      repoPath: text("repo_path").notNull(),
      blobSha: text("blob_sha"),
      key: text("key"),
      existingKey: text("existing_key"),
      secretScan: text("secret_scan").notNull().default("pending"),
      findings: jsonb("findings").$type<Array<{ kind: string; line: number }>>().notNull().default([]),
      error: text("error"),
      kind: text("kind").notNull(),
      size: bigint("size", { mode: "number" }).notNull().default(0),
      warnings: strings("warnings"),
      state: text("state").notNull().default("pending"),
      docId: uuid("doc_id"),
      assetId: uuid("asset_id"),
      confirmedBy: text("confirmed_by"),
      ...times(),
    },
    (t) => [
      unique("doc_import_files_import_path").on(t.importId, t.repoPath),
      foreignKey({ columns: [t.importId, t.orgId], foreignColumns: [docImports.id, docImports.orgId] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.assetId, t.orgId], foreignColumns: [docAssets.id, docAssets.orgId] }),
      check("doc_import_files_secret_scan", sql`secret_scan in ('pending', 'clean', 'found')`),
      check("doc_import_files_kind", sql`kind in ('markdown', 'image', 'office', 'other')`),
      check("doc_import_files_state", sql`state in ('pending', 'done', 'skipped', 'blocked_secret', 'failed')`),
      check("doc_import_files_size", sql`size >= 0`),
      index("doc_import_files_resume").on(t.orgId, t.importId, t.state),
      orgScoped("doc_import_files"),
    ],
  )
  .enableRLS();

// ---- Nhập Word (specs/019-word-import, plan.md mục 1) ---------------------------------------------------------------

/** Số file theo trạng thái, cùng khoá với `wordImportCounts` của contracts. */
export interface WordImportCountsRow {
  queued: number;
  converting: number;
  ready: number;
  skipped: number;
  blockedSecret: number;
  failed: number;
  proposed: number;
  cancelled: number;
  done: number;
}
const noFiles: WordImportCountsRow = {
  queued: 0,
  converting: 0,
  ready: 0,
  skipped: 0,
  blockedSecret: 0,
  failed: 0,
  proposed: 0,
  cancelled: 0,
  done: 0,
};

export const docWordImports = hive
  .table(
    "doc_word_imports",
    {
      ...identity(),
      homeId: uuid("home_id").notNull(),
      /** Thư mục đích trong repo khi tạo; cập nhật và gắn lấy đường dẫn theo tài liệu đích. */
      targetDir: text("target_dir"),
      mode: text("mode").notNull().default("create"),
      /** Tài liệu được cập nhật (US3) hoặc gắn với file Word (US6). */
      updateDocId: uuid("update_doc_id"),
      confidential: boolean("confidential").notNull().default(false),
      state: text("state").notNull().default("uploading"),
      counts: jsonb("counts").$type<WordImportCountsRow>().notNull().default(noFiles),
      createdBy: text("created_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("doc_word_imports_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.homeId, t.orgId], foreignColumns: [docHomes.id, docHomes.orgId] }).onDelete("cascade"),
      check("doc_word_imports_mode", sql`mode in ('create', 'update', 'link')`),
      check(
        "doc_word_imports_target",
        sql`(mode = 'create' and target_dir is not null and update_doc_id is null) or (mode <> 'create' and update_doc_id is not null)`,
      ),
      check(
        "doc_word_imports_state",
        sql`state in ('uploading', 'converting', 'ready', 'committing', 'done', 'failed', 'cancelled')`,
      ),
      index("doc_word_imports_home").on(t.orgId, t.homeId, t.createdAt),
      orgScoped("doc_word_imports"),
    ],
  )
  .enableRLS();

/** Ảnh đã tách khỏi file Word, giữ tạm tới khi tạo tài liệu; tên là 12 ký tự đầu SHA-256 kèm đuôi. */
export interface WordImportImageRow {
  name: string;
  blobId: string;
  mediaType: string;
  bytes: number;
}

export const docWordImportFiles = hive
  .table(
    "doc_word_import_files",
    {
      ...identity(),
      importId: uuid("import_id").notNull(),
      /** Thư mục con khi kéo cả thư mục; rỗng khi file nằm thẳng trong thư mục đích. */
      relativeDir: text("relative_dir").notNull().default(""),
      fileName: text("file_name").notNull(),
      format: text("format").notNull(),
      size: bigint("size", { mode: "number" }).notNull(),
      sha256: text("sha256").notNull(),
      /** File Word gốc; null khi đã dọn (đề xuất bị từ chối hoặc quá hạn giữ tạm). */
      blobId: uuid("blob_id"),
      /** Ngày sửa web gửi kèm, để chọn bản khi tên và phiên bản trùng (FR-006). */
      lastModified: timestamp("last_modified", { withTimezone: true }),
      versionLabel: text("version_label"),
      proposedPath: text("proposed_path"),
      proposedTitle: text("proposed_title"),
      pathOverride: text("path_override"),
      titleOverride: text("title_override"),
      keepFront: boolean("keep_front").notNull().default(false),
      excluded: boolean("excluded").notNull().default(false),
      state: text("state").notNull().default("queued"),
      markdown: text("markdown"),
      images: jsonb("images").$type<WordImportImageRow[]>().notNull().default([]),
      stats: jsonb("stats").$type<{ headings: number; tables: number; images: number }>(),
      warnings: jsonb("warnings")
        .$type<Array<{ code: string; count: number; detail: string | null }>>()
        .notNull()
        .default([]),
      /** Loại và dòng của chuỗi giống bí mật, không bao giờ lưu giá trị. */
      findings: jsonb("findings").$type<Array<{ kind: string; line: number }>>().notNull().default([]),
      error: jsonb("error").$type<{ code: string; message: string; detail?: string }>(),
      /** Gắn (FR-028): kết quả chuyển có khớp nội dung hiện tại không. */
      linkMatches: boolean("link_matches"),
      docId: uuid("doc_id"),
      docVersion: integer("doc_version"),
      /** Đề xuất đã gửi khi người nhập chỉ có quyền `propose` (P2). */
      proposalId: uuid("proposal_id"),
      ...times(),
    },
    (t) => [
      unique("doc_word_import_files_import_name").on(t.importId, t.relativeDir, t.fileName),
      foreignKey({
        columns: [t.importId, t.orgId],
        foreignColumns: [docWordImports.id, docWordImports.orgId],
      }).onDelete("cascade"),
      check("doc_word_import_files_format", sql`format in ('docx', 'odt', 'doc')`),
      check(
        "doc_word_import_files_state",
        sql`state in ('queued', 'converting', 'ready', 'skipped', 'blocked_secret', 'failed', 'proposed', 'cancelled', 'done')`,
      ),
      check("doc_word_import_files_size", sql`size >= 0`),
      check("doc_word_import_files_doc_version", sql`doc_version is null or doc_version >= 1`),
      index("doc_word_import_files_resume").on(t.orgId, t.importId, t.state),
      // Lần nhập gần nhất của một tài liệu: gốc khi cập nhật từ Word (P2) và nhãn "Nhập từ Word" (P3).
      index("doc_word_import_files_doc").on(t.orgId, t.docId),
      index("doc_word_import_files_blob").on(t.orgId, t.blobId),
      orgScoped("doc_word_import_files"),
    ],
  )
  .enableRLS();
