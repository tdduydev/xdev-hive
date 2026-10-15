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
      repoCommit: text("repo_commit").notNull(),
      repoContent: text("repo_content").notNull(),
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
      check("doc_assets_state", sql`state in ('available', 'missing_lfs', 'too_large', 'pending_push')`),
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
