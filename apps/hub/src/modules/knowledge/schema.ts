import type { ChecklistItem, CodeWorkflow, ReviewPhase, WorkflowSubject } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
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

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();

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
      /** Ghim: memory quan trọng lên đầu danh sách và vào ngữ cảnh máy dev trước (spec 029). */
      pinned: boolean("pinned").notNull().default(false),
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
      archivedAt: timestamp("archived_at", { withTimezone: true }),
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
      contentHash: text("content_hash"),
      source: text("source").notNull().default("hub"),
      repoCommit: text("repo_commit"),
      secretFlag: boolean("secret_flag").notNull().default(false),
      message: text("message"),
      proposalId: uuid("proposal_id"),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("doc_versions_doc_version").on(t.docId, t.version),
      foreignKey({ columns: [t.docId, t.orgId], foreignColumns: [docs.id, docs.orgId] }).onDelete("cascade"),
      authorCheck("doc_versions_author", "author"),
      check("doc_versions_source", sql`source in ('hub', 'repo', 'import', 'merge', 'word')`),
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
 * Bật/tắt skill trong bộ mặc định của Hive (packages/skill-pack). Chỉ lưu chỗ khác mặc định: project_id null là đặt
 * cho cả tổ chức, có project_id là đặt riêng cho dự án (thắng đặt của tổ chức). Nội dung skill nằm trong gói, không ở
 * database, nên không có bản ghi nào cho tổ chức chưa chỉnh gì.
 */
export const skillPackSettings = hive
  .table(
    "skill_pack_settings",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id"),
      name: text("name").notNull(),
      enabled: boolean("enabled").notNull(),
      updatedByUserId: text("updated_by_user_id").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("skill_pack_settings_scope_name").on(t.orgId, t.projectId, t.name).nullsNotDistinct(),
      orgScoped("skill_pack_settings"),
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
      /** Nơi đề xuất được tạo ra, vd. `{kind: "word", importFileId}` khi nhập Word chỉ có quyền đề xuất (P2). */
      origin: jsonb("origin").$type<{ kind: "word"; importFileId: string }>(),
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

/**
 * Quy trình duyệt tài liệu (specs/004-review-workflows). `phases` lưu nguyên khối đã kiểm bằng workflowInput của
 * contracts: quy trình đọc và ghi cả khối, phiên duyệt chép lại bản của lúc bắt đầu.
 */
export const reviewWorkflows = hive
  .table(
    "review_workflows",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      /** Đội sở hữu; null là quy trình của tổ chức. */
      teamId: uuid("team_id"),
      name: text("name").notNull(),
      preset: text("preset").notNull(),
      /** Quy trình cũ đều là tài liệu nên cột mới mặc định `doc`: nâng cấp không phải sửa dữ liệu. */
      subject: text("subject").$type<WorkflowSubject>().notNull().default("doc"),
      docPrefixes: text("doc_prefixes").array().notNull(),
      phases: jsonb("phases").$type<ReviewPhase[]>().notNull(),
      /** Phạm vi và tuỳ chọn của quy trình Code (specs/009); null với quy trình tài liệu. */
      code: jsonb("code").$type<CodeWorkflow>(),
      enabled: boolean("enabled").notNull().default(true),
      updatedBy: text("updated_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      check("review_workflows_subject", sql`subject in ('doc', 'code')`),
      // Khối `code` có đúng khi và chỉ khi là quy trình Code, để hai loại không lẫn nhau dù ghi tay vào bảng.
      check("review_workflows_code", sql`(subject = 'code') = (code is not null)`),
      orgScoped("review_workflows"),
    ],
  )
  .enableRLS();

/**
 * Một lần đi qua quy trình của một đề xuất sửa tài liệu. Chép tên và các giai đoạn của quy trình lúc bắt đầu: sửa quy
 * trình sau đó không đổi phiên đang chạy. `gate_index` là vị trí gate hiện tại khi trải phẳng các giai đoạn.
 */
export const reviewInstances = hive
  .table(
    "review_instances",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      proposalId: uuid("proposal_id").notNull(),
      workflowId: uuid("workflow_id"),
      workflowName: text("workflow_name").notNull(),
      phases: jsonb("phases").$type<ReviewPhase[]>().notNull(),
      docKey: text("doc_key").notNull(),
      docTitle: text("doc_title").notNull(),
      gateIndex: integer("gate_index").notNull().default(0),
      status: text("status").notNull().default("in_review"),
      /** Hướng trả lại lần gần nhất: đề xuất mới của tài liệu tiếp tục ở gate đó khi là `agent`. */
      route: text("route"),
      addedLines: integer("added_lines").notNull().default(0),
      deletedLines: integer("deleted_lines").notNull().default(0),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("review_instances_status", sql`status in ('in_review', 'changes_requested', 'approved', 'cancelled')`),
      scopeCheck("review_instances"),
      unique("review_instances_proposal").on(t.proposalId),
      foreignKey({ columns: [t.proposalId], foreignColumns: [proposals.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.workflowId], foreignColumns: [reviewWorkflows.id] }).onDelete("set null"),
      index("review_instances_org_status").on(t.orgId, t.status, t.updatedAt.desc()),
      index("review_instances_doc").on(t.orgId, t.docKey, t.createdAt.desc()),
      orgScoped("review_instances"),
    ],
  )
  .enableRLS();

/**
 * Mỗi lần một gate chạy trong phiên duyệt (gate có thể chạy lại khi bị trả về checkpoint trước). Gate người duyệt gom
 * từng lượt duyệt trong `approvals`; gate AI giữ run của agent kiểm.
 */
export const reviewGateRuns = hive
  .table(
    "review_gate_runs",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      instanceId: uuid("instance_id").notNull(),
      gateIndex: integer("gate_index").notNull(),
      gateId: text("gate_id").notNull(),
      status: text("status").notNull().default("waiting"),
      score: doublePrecision("score"),
      checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
      approvals: jsonb("approvals").$type<{ userId: string; at: string }[]>().notNull().default([]),
      note: text("note"),
      decidedBy: text("decided_by"),
      runId: uuid("run_id"),
      dueAt: timestamp("due_at", { withTimezone: true }),
      overdueNotifiedAt: timestamp("overdue_notified_at", { withTimezone: true }),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      check("review_gate_runs_status", sql`status in ('waiting', 'passed', 'failed', 'skipped')`),
      foreignKey({ columns: [t.instanceId], foreignColumns: [reviewInstances.id] }).onDelete("cascade"),
      index("review_gate_runs_instance").on(t.instanceId, t.startedAt),
      index("review_gate_runs_due").on(t.status, t.dueAt),
      orgScoped("review_gate_runs"),
      // hive.review_overdue_orgs (SECURITY DEFINER, chạy bằng hive_owner) tìm tổ chức có gate quá hạn để job nhắc.
      pgPolicy("review_gate_runs_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

// ---- Trình soạn tài liệu ----------------------------------------------------------------------------------------
// Khoá theo key tài liệu (không theo docs.id) vì tài liệu mới chỉ có dòng docs khi bản đầu tiên được duyệt. Phạm vi
// suy từ key lúc tạo, giống docs.

/** Bản nháp chung của cả đội cho một tài liệu; `revision` để lưu lạc quan khi nhiều người cùng sửa. */
export const docDrafts = hive
  .table(
    "doc_drafts",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      key: text("key").notNull(),
      title: text("title").notNull(),
      content: text("content").notNull(),
      baseVersion: integer("base_version").notNull(),
      revision: integer("revision").notNull().default(1),
      ...updatedByColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("doc_drafts_org_key").on(t.orgId, t.key),
      scopeCheck("doc_drafts"),
      authorCheck("doc_drafts_updated_by", "updated_by"),
      orgScoped("doc_drafts"),
    ],
  )
  .enableRLS();

/** Đề xuất sửa một đoạn của bản nháp, của người (chế độ Đề xuất) hoặc agent (MCP doc_suggest, trợ lý AI). */
export const docSuggestions = hive
  .table(
    "doc_suggestions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      key: text("key").notNull(),
      before: text("before").notNull(),
      after: text("after").notNull(),
      reason: text("reason"),
      ...authorColumns(),
      status: text("status").notNull().default("pending"),
      decidedBy: text("decided_by"),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("doc_suggestions_status", sql`status in ('pending', 'accepted', 'rejected')`),
      scopeCheck("doc_suggestions"),
      authorCheck("doc_suggestions_author", "author"),
      index("doc_suggestions_doc").on(t.orgId, t.key, t.status, t.createdAt),
      orgScoped("doc_suggestions"),
    ],
  )
  .enableRLS();

/** Luồng bình luận, neo vào một đoạn trích của tài liệu (hoặc chung cả tài liệu khi quote null). */
export const docThreads = hive
  .table(
    "doc_threads",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      key: text("key").notNull(),
      quote: text("quote"),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
      resolvedByUserId: text("resolved_by_user_id"),
      resolvedByRunId: uuid("resolved_by_run_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      scopeCheck("doc_threads"),
      index("doc_threads_doc").on(t.orgId, t.key, t.createdAt),
      orgScoped("doc_threads"),
    ],
  )
  .enableRLS();

export const docComments = hive
  .table(
    "doc_comments",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      body: text("body").notNull(),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      foreignKey({ columns: [t.threadId], foreignColumns: [docThreads.id] }).onDelete("cascade"),
      authorCheck("doc_comments_author", "author"),
      index("doc_comments_thread").on(t.threadId, t.createdAt),
      orgScoped("doc_comments"),
    ],
  )
  .enableRLS();

/** Bản chụp có tên của bản nháp; bản gửi duyệt là bản chụp gắn với đề xuất sửa tài liệu nó tạo ra. */
export const docSnapshots = hive
  .table(
    "doc_snapshots",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      ...scopeColumns(),
      key: text("key").notNull(),
      number: integer("number").notNull(),
      name: text("name").notNull(),
      title: text("title").notNull(),
      content: text("content").notNull(),
      baseVersion: integer("base_version").notNull(),
      proposalId: uuid("proposal_id"),
      note: text("note"),
      ...authorColumns(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("doc_snapshots_number").on(t.orgId, t.key, t.number),
      foreignKey({ columns: [t.proposalId], foreignColumns: [proposals.id] }).onDelete("set null"),
      scopeCheck("doc_snapshots"),
      authorCheck("doc_snapshots_author", "author"),
      orgScoped("doc_snapshots"),
    ],
  )
  .enableRLS();

/** Ai đang mở trình soạn: cập nhật mỗi lần trình soạn hỏi trạng thái, coi là rời đi sau một phút im lặng. */
export const docPresence = hive
  .table(
    "doc_presence",
    {
      orgId: uuid("org_id").notNull(),
      key: text("key").notNull(),
      userId: text("user_id").notNull(),
      seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
      editedAt: timestamp("edited_at", { withTimezone: true }),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.key, t.userId] }), orgScoped("doc_presence")],
  )
  .enableRLS();

/**
 * Bản tóm tắt repo của dự án, đưa vào prompt của mọi run (ADR 0022). Mỗi dự án một dòng; không giữ lịch sử như docs
 * vì brief được viết lại cả bản mỗi lần làm mới và chỉ bản hiện tại có ích cho agent.
 */
export const projectBriefs = hive
  .table(
    "project_briefs",
    {
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      projectId: uuid("project_id").primaryKey(),
      content: text("content").notNull(),
      version: integer("version").notNull().default(1),
      /** Commit của nhánh chính agent đã đọc; null khi người viết tay lúc chưa có brief nào của agent. */
      commitSha: text("commit_sha"),
      source: text("source").$type<"agent" | "user">().notNull(),
      ...updatedByColumns(),
      /** Nhánh chính worker thấy ở run gần nhất và số commit nó đi trước commit_sha, để biết khi nào làm mới. */
      headSha: text("head_sha"),
      commitsBehind: integer("commits_behind"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    () => [
      check("project_briefs_content_len", sql`char_length(content) between 1 and 12000`),
      check("project_briefs_source", sql`source in ('agent', 'user')`),
      authorCheck("project_briefs_updated_by", "updated_by"),
      orgScoped("project_briefs"),
    ],
  )
  .enableRLS();

// embedding được thêm bởi enable_doc_vectors để database không có pgvector vẫn tìm theo từ được.
export const docChunks = hive
  .table(
    "doc_chunks",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      docId: uuid("doc_id"),
      extractId: uuid("extract_id"),
      version: integer("version").notNull(),
      ord: integer("ord").notNull(),
      headingPath: text("heading_path").array().notNull().default(sql`'{}'::text[]`),
      content: text("content").notNull(),
      embeddingModel: text("embedding_model"),
      search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content)`),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("doc_chunks_parent", sql`(doc_id is null) <> (extract_id is null)`),
      check("doc_chunks_position", sql`version > 0 and ord >= 0`),
      foreignKey({ columns: [t.docId, t.orgId], foreignColumns: [docs.id, docs.orgId] }).onDelete("cascade"),
      unique("doc_chunks_doc_version_ord").on(t.docId, t.version, t.ord),
      unique("doc_chunks_extract_version_ord").on(t.extractId, t.version, t.ord),
      index("doc_chunks_org").on(t.orgId),
      index("doc_chunks_search").using("gin", t.search),
      orgScoped("doc_chunks"),
    ],
  )
  .enableRLS();
