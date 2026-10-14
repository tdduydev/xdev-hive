import type { ProjectSdlcSettings, SdlcMode, SdlcSize, SdlcSuggestion } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Khai báo lại schema và role thay vì lấy từ module khác: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

/*
 * Bảng của chế độ AI SDLC (specs/011-ai-sdlc-mode, plan.md "Data Model"). Như codereview, không khai khoá ngoại tới
 * bảng của module khác trong schema: khoá ngoại tới `tasks` nằm trong migration viết tay. Bảng con trỏ tới hạng mục và
 * tài liệu bằng khoá kép (id, org_id), vì khoá ngoại bỏ qua RLS nên thiếu org_id thì trỏ được sang tổ chức khác.
 */

/** Nguồn của hạng mục; chỉ mục `sdlc_items_issue` đọc `kind` và `issueNumber`. */
export type SdlcItemSourceRow = {
  kind: "manual" | "issue" | "leader" | "repo";
  url: string | null;
  issueNumber: number | null;
  path: string | null;
};

/** Chế độ tự tạo của đội hoặc tổ chức. Preset là hằng trong contracts, không lưu ở đây (D2). */
export const sdlcModes = hive
  .table(
    "sdlc_modes",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      /** null: chế độ của tổ chức. */
      teamId: uuid("team_id"),
      slug: text("slug").notNull(),
      name: text("name").notNull(),
      method: text("method").notNull(),
      basePreset: text("base_preset"),
      definition: jsonb("definition").$type<SdlcMode>().notNull(),
      version: integer("version").notNull().default(1),
      enabled: boolean("enabled").notNull().default(true),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [unique("sdlc_modes_org_slug").on(t.orgId, t.slug), orgScoped("sdlc_modes")],
  )
  .enableRLS();

/**
 * Hạng mục: một yêu cầu đi qua các giai đoạn của chế độ. Chụp chế độ và cài đặt lúc tạo để sửa chế độ sau đó không đổi
 * luật giữa chừng. `team_id` là đội của dự án chính (D22).
 */
export const sdlcItems = hive
  .table(
    "sdlc_items",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      /** Dự án chính: giữ số `NNN` và tài liệu chung (D19). */
      projectId: uuid("project_id").notNull(),
      number: integer("number").notNull(),
      slug: text("slug").notNull(),
      title: text("title").notNull(),
      idea: text("idea").notNull(),
      source: jsonb("source").$type<SdlcItemSourceRow>().notNull(),
      /** Id preset hoặc slug chế độ tự tạo. */
      modeRef: text("mode_ref").notNull(),
      mode: jsonb("mode").$type<SdlcMode>().notNull(),
      settings: jsonb("settings").$type<ProjectSdlcSettings>().notNull(),
      sizeSuggested: text("size_suggested").$type<SdlcSize>(),
      size: text("size").$type<SdlcSize>().notNull(),
      suggestion: jsonb("suggestion").$type<SdlcSuggestion>(),
      status: text("status").$type<"active" | "paused" | "done" | "cancelled">().notNull().default("active"),
      phaseIndex: integer("phase_index").notNull().default(0),
      convergeRound: integer("converge_round").notNull().default(0),
      convergedAt: timestamp("converged_at", { withTimezone: true }),
      ownerUserId: text("owner_user_id").notNull(),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      doneAt: timestamp("done_at", { withTimezone: true }),
    },
    (t) => [
      unique("sdlc_items_project_number").on(t.projectId, t.number),
      unique("sdlc_items_id_org").on(t.id, t.orgId),
      check("sdlc_items_status", sql`status in ('active', 'paused', 'done', 'cancelled')`),
      check("sdlc_items_size", sql`size in ('S', 'M', 'L', 'XL')`),
      index("sdlc_items_board").on(t.orgId, t.status, t.updatedAt.desc()),
      // Một issue chỉ thành một hạng mục (FR-004), kể cả khi hai người nhận cùng lúc.
      uniqueIndex("sdlc_items_issue")
        .on(t.projectId, sql`(source->>'issueNumber')`)
        .where(sql`source->>'kind' = 'issue'`),
      orgScoped("sdlc_items"),
      // hive.sdlc_active_orgs (SECURITY DEFINER, chạy bằng hive_owner) tìm tổ chức có hạng mục đang chạy.
      pgPolicy("sdlc_items_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

const itemFk = (name: string, t: { itemId: AnyPgColumn; orgId: AnyPgColumn }) =>
  foreignKey({ name, columns: [t.itemId, t.orgId], foreignColumns: [sdlcItems.id, sdlcItems.orgId] }).onDelete(
    "cascade",
  );

/** Mọi dự án của hạng mục, kể cả dự án chính (D19). Bộ lọc quyền (D22) join bảng này theo `team_id`. */
export const sdlcItemProjects = hive
  .table(
    "sdlc_item_projects",
    {
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      projectId: uuid("project_id").notNull(),
      teamId: uuid("team_id").notNull(),
      role: text("role").$type<"home" | "participant">().notNull(),
      /** Bản chụp cài đặt của dự án lúc thêm: chặn, đồng bộ, song song, nhãn theo bản này. */
      settings: jsonb("settings").$type<ProjectSdlcSettings>().notNull(),
      addedBy: text("added_by").notNull(),
      addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
      removedAt: timestamp("removed_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.itemId, t.projectId] }),
      check("sdlc_item_projects_role", sql`role in ('home', 'participant')`),
      itemFk("sdlc_item_projects_item_fk", t),
      uniqueIndex("sdlc_item_projects_home").on(t.itemId).where(sql`role = 'home'`),
      index("sdlc_item_projects_team").on(t.orgId, t.teamId).where(sql`removed_at IS NULL`),
      index("sdlc_item_projects_project").on(t.projectId).where(sql`removed_at IS NULL`),
      orgScoped("sdlc_item_projects"),
    ],
  )
  .enableRLS();

export const sdlcItemPhases = hive
  .table(
    "sdlc_item_phases",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      phaseIndex: integer("phase_index").notNull(),
      phaseId: text("phase_id").notNull(),
      kind: text("kind").notNull(),
      status: text("status")
        .$type<"pending" | "drafting" | "awaiting_answers" | "in_review" | "approved" | "skipped">()
        .notNull()
        .default("pending"),
      note: text("note"),
      decidedBy: text("decided_by"),
      startedAt: timestamp("started_at", { withTimezone: true }),
      approvedAt: timestamp("approved_at", { withTimezone: true }),
    },
    (t) => [
      unique("sdlc_item_phases_item_index").on(t.itemId, t.phaseIndex),
      check(
        "sdlc_item_phases_status",
        sql`status in ('pending', 'drafting', 'awaiting_answers', 'in_review', 'approved', 'skipped')`,
      ),
      itemFk("sdlc_item_phases_item_fk", t),
      orgScoped("sdlc_item_phases"),
    ],
  )
  .enableRLS();

/**
 * Tài liệu của hạng mục. `project_id` là dự án giữ file nguồn: dự án chính (scope item), chính dự án đó (project), bên
 * cung cấp (contract). Bản gốc nằm ở hub theo `doc_key` (D20); repo chỉ là bản sao đồng bộ.
 */
export const sdlcArtifacts = hive
  .table(
    "sdlc_artifacts",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id").notNull(),
      itemId: uuid("item_id").notNull(),
      phaseId: text("phase_id").notNull(),
      artifactId: text("artifact_id").notNull(),
      required: boolean("required").notNull(),
      scope: text("scope").$type<"item" | "project" | "contract">().notNull().default("item"),
      /** '' (item), key dự án (project), tên contract (contract). */
      instance: text("instance").notNull().default(""),
      /** Chỉ contract (D23): repo bên dùng nhận bản sao. */
      consumerProjectIds: uuid("consumer_project_ids").array().notNull().default(sql`'{}'::uuid[]`),
      contractFormat: text("contract_format"),
      docKey: text("doc_key").notNull(),
      repoPath: text("repo_path").notNull(),
      baselineVersion: integer("baseline_version"),
      baselineHash: text("baseline_hash"),
      /** Cách có baseline hiện tại (D26): người duyệt, tự duyệt, đã thu hồi, duyệt lại sau thu hồi. */
      approval: text("approval")
        .$type<"none" | "human" | "auto" | "revoked" | "reaffirmed">()
        .notNull()
        .default("none"),
    },
    (t) => [
      unique("sdlc_artifacts_doc_key").on(t.docKey),
      unique("sdlc_artifacts_item_artifact").on(t.itemId, t.artifactId, t.instance),
      unique("sdlc_artifacts_id_org").on(t.id, t.orgId),
      check("sdlc_artifacts_scope", sql`scope in ('item', 'project', 'contract')`),
      check("sdlc_artifacts_approval", sql`approval in ('none', 'human', 'auto', 'revoked', 'reaffirmed')`),
      itemFk("sdlc_artifacts_item_fk", t),
      orgScoped("sdlc_artifacts"),
    ],
  )
  .enableRLS();

const artifactFk = (name: string, t: { artifactId: AnyPgColumn; orgId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.artifactId, t.orgId],
    foreignColumns: [sdlcArtifacts.id, sdlcArtifacts.orgId],
  }).onDelete("cascade");

/** Mỗi (tài liệu, repo) một dòng: file nguồn ở repo của dự án giữ tài liệu, bản sao contract ở repo bên dùng (D23). */
export const sdlcArtifactSyncs = hive
  .table(
    "sdlc_artifact_syncs",
    {
      orgId: uuid("org_id").notNull(),
      artifactId: uuid("artifact_id").notNull(),
      projectId: uuid("project_id").notNull(),
      kind: text("kind").$type<"source" | "copy">().notNull(),
      repoPath: text("repo_path").notNull(),
      syncedVersion: integer("synced_version"),
      syncedCommit: text("synced_commit"),
      syncedHash: text("synced_hash"),
      repoHash: text("repo_hash"),
      syncState: text("sync_state")
        .$type<"none" | "pending" | "synced" | "failed" | "drifted" | "deleted">()
        .notNull()
        .default("none"),
      syncError: text("sync_error"),
      syncAttempts: integer("sync_attempts").notNull().default(0),
      syncedAt: timestamp("synced_at", { withTimezone: true }),
      /** PR đồng bộ của repo (cách `pr`); giữ sau khi merge để màn hạng mục còn link. */
      prNumber: integer("pr_number"),
      prUrl: text("pr_url"),
    },
    (t) => [
      primaryKey({ columns: [t.artifactId, t.projectId] }),
      check("sdlc_artifact_syncs_kind", sql`kind in ('source', 'copy')`),
      check(
        "sdlc_artifact_syncs_state",
        sql`sync_state in ('none', 'pending', 'synced', 'failed', 'drifted', 'deleted')`,
      ),
      artifactFk("sdlc_artifact_syncs_artifact_fk", t),
      // Webhook push tìm tài liệu theo file đổi trong repo.
      index("sdlc_artifact_syncs_repo").on(t.projectId, t.repoPath),
      orgScoped("sdlc_artifact_syncs"),
    ],
  )
  .enableRLS();

/** Câu hỏi agent hỏi lại người qua `sdlc_ask`; mỗi vòng tối đa vài câu. */
export const sdlcQuestions = hive
  .table(
    "sdlc_questions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      phaseId: text("phase_id").notNull(),
      stepId: uuid("step_id"),
      runId: uuid("run_id"),
      round: integer("round").notNull(),
      position: integer("position").notNull(),
      text: text("text").notNull(),
      options: jsonb("options").$type<string[]>().notNull().default([]),
      recommended: text("recommended"),
      context: text("context"),
      answer: text("answer"),
      usedRecommended: boolean("used_recommended").notNull().default(false),
      answeredBy: text("answered_by"),
      answeredAt: timestamp("answered_at", { withTimezone: true }),
      remindedAt: timestamp("reminded_at", { withTimezone: true }),
      status: text("status").$type<"open" | "answered" | "withdrawn">().notNull().default("open"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("sdlc_questions_status", sql`status in ('open', 'answered', 'withdrawn')`),
      itemFk("sdlc_questions_item_fk", t),
      index("sdlc_questions_open").on(t.orgId, t.status, t.createdAt),
      orgScoped("sdlc_questions"),
    ],
  )
  .enableRLS();

/** Mỗi lần chạy một bước của giai đoạn (soạn, phân tích, hội tụ…); bước `auto` có run `sdlc`. */
export const sdlcSteps = hive
  .table(
    "sdlc_steps",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      phaseId: text("phase_id").notNull(),
      stepId: text("step_id").notNull(),
      action: text("action").notNull(),
      round: integer("round").notNull().default(1),
      runId: uuid("run_id"),
      status: text("status")
        .$type<"queued" | "running" | "succeeded" | "failed" | "cancelled">()
        .notNull()
        .default("queued"),
      instructions: text("instructions"),
      result: jsonb("result").$type<Record<string, unknown>>(),
      error: text("error"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      check("sdlc_steps_status", sql`status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
      itemFk("sdlc_steps_item_fk", t),
      index("sdlc_steps_item").on(t.itemId, t.createdAt),
      // Run xong thì tìm bước của nó; một run chỉ phục vụ một bước.
      uniqueIndex("sdlc_steps_run").on(t.runId).where(sql`run_id IS NOT NULL`),
      orgScoped("sdlc_steps"),
    ],
  )
  .enableRLS();

/** Task do bản tách tạo. `project_id` chép từ task (D24) để lọc theo dự án không phải join `tasks`. */
export const sdlcItemTasks = hive
  .table(
    "sdlc_item_tasks",
    {
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      taskId: uuid("task_id").notNull(),
      projectId: uuid("project_id").notNull(),
      sliceKey: text("slice_key").notNull(),
      wave: integer("wave").notNull(),
      requirementIds: text("requirement_ids").array().notNull().default(sql`'{}'::text[]`),
      removed: boolean("removed").notNull().default(false),
      breakdownVersion: integer("breakdown_version").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.itemId, t.taskId] }),
      unique("sdlc_item_tasks_slice").on(t.itemId, t.sliceKey),
      itemFk("sdlc_item_tasks_item_fk", t),
      // Một task thuộc nhiều nhất một hạng mục; cổng chặn run code tra theo task.
      uniqueIndex("sdlc_item_tasks_task").on(t.taskId),
      orgScoped("sdlc_item_tasks"),
    ],
  )
  .enableRLS();

/** Liên kết truy vết requirement → task, run, PR, commit, test, CI, finding. `project_id` null: cấp hạng mục. */
export const sdlcTraceLinks = hive
  .table(
    "sdlc_trace_links",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      requirementId: text("requirement_id").notNull(),
      kind: text("kind").$type<"task" | "run" | "pr" | "commit" | "test" | "ci" | "finding">().notNull(),
      ref: text("ref").notNull(),
      projectId: uuid("project_id"),
      taskId: uuid("task_id"),
      runId: uuid("run_id"),
      data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("sdlc_trace_links_ref").on(t.itemId, t.requirementId, t.kind, t.ref),
      check("sdlc_trace_links_kind", sql`kind in ('task', 'run', 'pr', 'commit', 'test', 'ci', 'finding')`),
      itemFk("sdlc_trace_links_item_fk", t),
      orgScoped("sdlc_trace_links"),
    ],
  )
  .enableRLS();

/**
 * Ngoại lệ cho cổng chặn: có `task_id` thì một task; chỉ `project_id` thì mọi task của dự án trong hạng mục; cả hai
 * null thì cả hạng mục. Khoá ngoại tới `tasks` nằm trong migration viết tay.
 */
export const sdlcOverrides = hive
  .table(
    "sdlc_overrides",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      taskId: uuid("task_id"),
      projectId: uuid("project_id"),
      reason: text("reason").notNull(),
      decidedBy: text("decided_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedBy: text("revoked_by"),
    },
    (t) => [
      check("sdlc_overrides_reason", sql`char_length(reason) >= 10`),
      itemFk("sdlc_overrides_item_fk", t),
      index("sdlc_overrides_active").on(t.itemId).where(sql`revoked_at IS NULL`),
      orgScoped("sdlc_overrides"),
    ],
  )
  .enableRLS();

/** Mỗi checkpoint người được tự duyệt một dòng (D25, D26); thu hồi trong hạn thì mở lại phiên duyệt. */
export const sdlcAutoApprovals = hive
  .table(
    "sdlc_auto_approvals",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      itemId: uuid("item_id").notNull(),
      artifactId: uuid("artifact_id").notNull(),
      reviewId: uuid("review_id").notNull(),
      gateId: text("gate_id").notNull(),
      proposalId: uuid("proposal_id"),
      /** Điền khi baseline. */
      version: integer("version"),
      score: numeric("score", { precision: 4, scale: 2, mode: "number" }).notNull(),
      threshold: numeric("threshold", { precision: 4, scale: 2, mode: "number" }).notNull(),
      /** Điều kiện đã xét, điểm từng mục, reviewer cli/model, tác giả bản nháp. */
      reasons: jsonb("reasons").$type<Record<string, unknown>>().notNull(),
      decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
      revocableUntil: timestamp("revocable_until", { withTimezone: true }).notNull(),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedBy: text("revoked_by"),
      revokeReason: text("revoke_reason"),
      rereviewId: uuid("rereview_id"),
    },
    (t) => [
      unique("sdlc_auto_approvals_gate").on(t.reviewId, t.gateId),
      check("sdlc_auto_approvals_revoke", sql`revoked_at IS NULL OR char_length(revoke_reason) >= 10`),
      itemFk("sdlc_auto_approvals_item_fk", t),
      artifactFk("sdlc_auto_approvals_artifact_fk", t),
      index("sdlc_auto_approvals_item").on(t.itemId, t.decidedAt.desc()),
      orgScoped("sdlc_auto_approvals"),
    ],
  )
  .enableRLS();
