import type { ProjectSettings } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
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

// Khai báo lại schema và role thay vì lấy từ tenancy: module chỉ được import module khác qua index.ts.
const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();

const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });

export const projectState = hive.enum("project_state", ["provisioning", "active", "failed", "archived"]);
export const repoMode = hive.enum("project_repo_mode", ["new", "existing"]);
export const provisionStepKind = hive.enum("provision_step_kind", [
  "check-access",
  "create-repo",
  "link-repo",
  "commit-template",
  "protect-branch",
  "add-webhook",
]);
export const provisionStepState = hive.enum("provision_step_state", [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);

export interface StepError {
  code: string;
  message: string;
  fix: string | null;
}

/**
 * Dự án thuộc một hệ thống, hệ thống thuộc một đội. Khoá ngoại tới systems, teams và scm_connections (bảng của
 * module khác) nằm trong migration viết tay; (system_id, team_id) trỏ tới systems nên team_id luôn khớp hệ thống.
 */
export const projects = hive
  .table(
    "projects",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      teamId: uuid("team_id").notNull(),
      systemId: uuid("system_id").notNull(),
      key: text("key").notNull(),
      name: text("name").notNull(),
      scmConnectionId: uuid("scm_connection_id").notNull(),
      /** Chép từ kết nối lúc tạo, để đọc danh sách không phải join sang bảng của scm. */
      scmKind: text("scm_kind").$type<"github" | "gitlab">().notNull(),
      repoMode: repoMode("repo_mode").notNull(),
      repoOwner: text("repo_owner").notNull(),
      repoName: text("repo_name").notNull(),
      repoVisibility: text("repo_visibility").$type<"private" | "internal" | "public">(),
      /** null tới khi biết từ provider (repo có sẵn). */
      defaultBranch: text("default_branch"),
      repoExternalId: text("repo_external_id"),
      repoHttpUrl: text("repo_http_url"),
      repoSshUrl: text("repo_ssh_url"),
      repoWebUrl: text("repo_web_url"),
      state: projectState("state").notNull().default("provisioning"),
      settings: jsonb("settings").$type<ProjectSettings>().notNull(),
      idempotencyKey: uuid("idempotency_key").notNull(),
      /** Secret ký webhook của riêng dự án, mã hoá envelope. */
      webhookSecretEnc: text("webhook_secret_enc"),
      createdBy: text("created_by").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      unique("projects_org_key").on(t.orgId, t.key),
      // Gửi lại cùng khoá chống trùng trả về dự án đã tạo thay vì tạo thêm.
      unique("projects_org_idempotency").on(t.orgId, t.idempotencyKey),
      unique("projects_id_org").on(t.id, t.orgId),
      // Một repo chỉ thuộc một dự án; GitHub và GitLab không phân biệt hoa thường trong đường dẫn.
      uniqueIndex("projects_repo").on(t.scmConnectionId, sql`lower(${t.repoOwner})`, sql`lower(${t.repoName})`),
      index("projects_org_team").on(t.orgId, t.teamId),
      index("projects_system").on(t.systemId),
      orgScoped("projects"),
      // Endpoint webhook chưa biết tổ chức: chỉ đọc được đúng dự án có id trong app.webhook_project_id (webhook-target.ts).
      pgPolicy("projects_webhook_lookup", {
        for: "select",
        to: hiveApp,
        using: sql`id = hive.ctx_webhook_project()`,
      }),
    ],
  )
  .enableRLS();

/**
 * Các bước saga khởi tạo của một dự án. Mỗi bước ghi trạng thái riêng, nên chạy lại chỉ làm bước chưa xong và
 * màn tiến trình đọc thẳng bảng này.
 */
export const projectProvisionSteps = hive
  .table(
    "project_provision_steps",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      orgId: uuid("org_id").notNull(),
      projectId: uuid("project_id").notNull(),
      position: integer("position").notNull(),
      kind: provisionStepKind("kind").notNull(),
      /** Đối tượng của bước khi một loại bước lặp nhiều lần (ví dụ máy clone); null với bước chỉ có một. */
      target: text("target"),
      state: provisionStepState("state").notNull().default("pending"),
      /** Tham số chốt lúc tạo dự án (ví dụ số người duyệt), để chạy lại vẫn ra cùng kết quả. */
      params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
      result: jsonb("result").$type<Record<string, unknown>>(),
      error: jsonb("error").$type<StepError>(),
      attempts: integer("attempts").notNull().default(0),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      unique("project_provision_steps_position").on(t.projectId, t.position),
      foreignKey({ columns: [t.projectId, t.orgId], foreignColumns: [projects.id, projects.orgId] }).onDelete(
        "cascade",
      ),
      index("project_provision_steps_org").on(t.orgId),
      orgScoped("project_provision_steps"),
    ],
  )
  .enableRLS();
