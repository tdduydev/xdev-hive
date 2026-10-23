import type { DeployStep, DeployVersion, EnvironmentPolicy } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "../tenancy/index.ts";

// Khoá ngoại kép tới projects (catalog) và systems (tenancy) nằm trong migration viết tay như các module khác, để schema
// không kéo cả module catalog vào lúc drizzle-kit đọc file.

const hive = pgSchema("hive");
const hiveApp = pgRole("hive_app").existing();
const hiveOwner = pgRole("hive_owner").existing();
const inOrg = sql`org_id = hive.ctx_org()`;
const orgScoped = (name: string) => pgPolicy(`${name}_rw`, { for: "all", to: hiveApp, using: inOrg, withCheck: inOrg });
const identity = () => ({ id: uuid("id").primaryKey().defaultRandom(), orgId: uuid("org_id").notNull() });
const at = (name: string) => timestamp(name, { withTimezone: true });
const times = () => ({
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Host key đã xác nhận. Giữ thuật toán vì máy có nhiều host key thì dấu vân tay theo thuật toán thương lượng được. */
export interface HostKey {
  algorithm: string;
  fingerprint: string;
}

export const ciJenkinsConnections = hive
  .table(
    "ci_jenkins_connections",
    {
      ...identity(),
      name: text("name").notNull(),
      url: text("url").notNull(),
      /** Token của người này dùng cho đọc theo lịch; null khi người theo dõi rời tổ chức. */
      watcherUserId: text("watcher_user_id"),
      lastPollAt: at("last_poll_at"),
      lastError: text("last_error"),
      createdBy: text("created_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("ci_jenkins_connections_org_name").on(t.orgId, t.name),
      unique("ci_jenkins_connections_id_org").on(t.id, t.orgId),
      orgScoped("ci_jenkins_connections"),
      // hive.delivery_active_orgs (SECURITY DEFINER, chạy bằng hive_owner) tìm tổ chức có việc đọc CI theo cron.
      pgPolicy("ci_jenkins_connections_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/** Token cá nhân: thao tác ghi trên Jenkins mang tên người bấm. Mã hoá với ngữ cảnh `ci_jenkins_user_tokens:<id>`. */
export const ciJenkinsUserTokens = hive
  .table(
    "ci_jenkins_user_tokens",
    {
      ...identity(),
      connectionId: uuid("connection_id").notNull(),
      userId: text("user_id").notNull(),
      jenkinsUser: text("jenkins_user").notNull(),
      tokenEnc: text("token_enc").notNull(),
      lastCheckedAt: at("last_checked_at"),
      lastCheckOk: boolean("last_check_ok"),
      ...times(),
    },
    (t) => [
      unique("ci_jenkins_user_tokens_connection_user").on(t.connectionId, t.userId),
      foreignKey({
        columns: [t.connectionId, t.orgId],
        foreignColumns: [ciJenkinsConnections.id, ciJenkinsConnections.orgId],
      }).onDelete("cascade"),
      orgScoped("ci_jenkins_user_tokens"),
    ],
  )
  .enableRLS();

/** Argo CD, Kubernetes. Token mã hoá với ngữ cảnh `deploy_connections:<id>`. */
export const deployConnections = hive
  .table(
    "deploy_connections",
    {
      ...identity(),
      kind: text("kind").notNull(),
      name: text("name").notNull(),
      url: text("url").notNull(),
      caPem: text("ca_pem"),
      tokenEnc: text("token_enc").notNull(),
      createdBy: text("created_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("deploy_connections_org_name").on(t.orgId, t.name),
      unique("deploy_connections_id_org").on(t.id, t.orgId),
      check("deploy_connections_kind", sql`kind in ('argocd', 'kubernetes')`),
      orgScoped("deploy_connections"),
    ],
  )
  .enableRLS();

export const ciProjectJobs = hive
  .table(
    "ci_project_jobs",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      jobPath: text("job_path").notNull(),
      createdBy: text("created_by").notNull(),
      createdAt: at("created_at").notNull().defaultNow(),
    },
    (t) => [
      unique("ci_project_jobs_project_job").on(t.projectId, t.connectionId, t.jobPath),
      foreignKey({
        columns: [t.connectionId, t.orgId],
        foreignColumns: [ciJenkinsConnections.id, ciJenkinsConnections.orgId],
      }).onDelete("cascade"),
      index("ci_project_jobs_connection").on(t.connectionId),
      orgScoped("ci_project_jobs"),
      pgPolicy("ci_project_jobs_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/** Trạng thái cuối đã thấy của pipeline/build, để báo đỏ một lần và báo xanh lại. Không chứa log. */
export const ciRunsSeen = hive
  .table(
    "ci_runs_seen",
    {
      ...identity(),
      projectId: uuid("project_id"),
      source: text("source").notNull(),
      externalId: text("external_id").notNull(),
      status: text("status").notNull(),
      branch: text("branch"),
      finishedAt: at("finished_at"),
      notifiedState: text("notified_state"),
      ...times(),
    },
    (t) => [
      unique("ci_runs_seen_source_external").on(t.orgId, t.source, t.externalId),
      check("ci_runs_seen_source", sql`source in ('gitlab', 'github', 'jenkins')`),
      index("ci_runs_seen_project").on(t.projectId),
      orgScoped("ci_runs_seen"),
      pgPolicy("ci_runs_seen_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Máy chủ của đội. Khoá riêng ed25519 do hub sinh, mã hoá với ngữ cảnh `deploy_servers:<id>:key`; khoá `pending_*` chỉ
 * thay khoá cũ khi kiểm kết nối bằng nó thành công.
 */
export const deployServers = hive
  .table(
    "deploy_servers",
    {
      ...identity(),
      teamId: uuid("team_id").notNull(),
      name: text("name").notNull(),
      host: text("host").notNull(),
      port: integer("port").notNull().default(22),
      sshUser: text("ssh_user").notNull(),
      labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
      privateKeyEnc: text("private_key_enc").notNull(),
      publicKey: text("public_key").notNull(),
      pendingPrivateKeyEnc: text("pending_private_key_enc"),
      pendingPublicKey: text("pending_public_key"),
      pendingKeyCreatedAt: at("pending_key_created_at"),
      hostKeys: jsonb("host_keys").$type<HostKey[]>().notNull().default([]),
      lastTestAt: at("last_test_at"),
      lastTestOk: boolean("last_test_ok"),
      lastTestMessage: text("last_test_message"),
      createdBy: text("created_by").notNull(),
      ...times(),
    },
    (t) => [
      unique("deploy_servers_team_name").on(t.teamId, t.name),
      unique("deploy_servers_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      check("deploy_servers_port", sql`port between 1 and 65535`),
      check(
        "deploy_servers_pending_key",
        sql`(pending_private_key_enc is null) = (pending_public_key is null)
          and (pending_private_key_enc is null) = (pending_key_created_at is null)`,
      ),
      check("deploy_servers_host_keys", sql`jsonb_typeof(host_keys) = 'array'`),
      orgScoped("deploy_servers"),
    ],
  )
  .enableRLS();

/**
 * Môi trường của hệ thống. Giữ team_id để khoá ngoại (system_id, team_id) trỏ tới systems và (team_id, org_id) tới
 * teams: systems không có khoá (id, org_id), mà khoá ngoại bỏ qua RLS nên phải chặn trỏ chéo tổ chức bằng chuỗi này.
 */
export const deployEnvironments = hive
  .table(
    "deploy_environments",
    {
      ...identity(),
      teamId: uuid("team_id").notNull(),
      systemId: uuid("system_id").notNull(),
      name: text("name").notNull(),
      position: integer("position").notNull().default(0),
      policy: jsonb("policy").$type<EnvironmentPolicy>().notNull(),
      lockedAt: at("locked_at"),
      lockedBy: text("locked_by"),
      lockReason: text("lock_reason"),
      /** `worker`: chạy trên máy trong mạng nội bộ; `legacy`: hub tự gọi (HIVE_DELIVERY_OUTBOUND), giữ để chuyển dần. */
      runner: text("runner").notNull().default("worker"),
      /** Máy chạy deploy của tổ chức này theo thứ tự ưu tiên; rỗng thì chọn máy nào đủ điều kiện. */
      runnerMachines: uuid("runner_machines").array().notNull().default(sql`'{}'::uuid[]`),
      runnerLabelRequired: boolean("runner_label_required").notNull().default(false),
      ...times(),
    },
    (t) => [
      unique("deploy_environments_system_name").on(t.systemId, t.name),
      unique("deploy_environments_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.teamId, t.orgId], foreignColumns: [teams.id, teams.orgId] }).onDelete("cascade"),
      check("deploy_environments_lock", sql`(locked_at is null) = (lock_reason is null)`),
      check("deploy_environments_policy", sql`jsonb_typeof(policy) = 'object'`),
      check("deploy_environments_runner", sql`runner in ('worker', 'legacy')`),
      orgScoped("deploy_environments"),
    ],
  )
  .enableRLS();

/** Cấu hình theo cách triển khai, có `schemaVersion` (zod ở contracts); `config_version` để khoá lạc quan khi sửa. */
export const deployTargets = hive
  .table(
    "deploy_targets",
    {
      ...identity(),
      projectId: uuid("project_id").notNull(),
      environmentId: uuid("environment_id").notNull(),
      method: text("method").notNull(),
      config: jsonb("config").$type<Record<string, unknown>>().notNull(),
      configVersion: integer("config_version").notNull().default(1),
      serverId: uuid("server_id"),
      connectionId: uuid("connection_id"),
      updatedBy: text("updated_by"),
      ...times(),
    },
    (t) => [
      unique("deploy_targets_project_environment").on(t.projectId, t.environmentId),
      unique("deploy_targets_id_org").on(t.id, t.orgId),
      foreignKey({
        columns: [t.environmentId, t.orgId],
        foreignColumns: [deployEnvironments.id, deployEnvironments.orgId],
      }).onDelete("cascade"),
      // Máy chủ, kết nối còn đích dùng thì không xoá được: xoá ngầm làm đích hỏng mà người dùng không biết.
      foreignKey({ columns: [t.serverId, t.orgId], foreignColumns: [deployServers.id, deployServers.orgId] }),
      foreignKey({
        columns: [t.connectionId, t.orgId],
        foreignColumns: [deployConnections.id, deployConnections.orgId],
      }),
      check(
        "deploy_targets_method",
        sql`method in ('ssh-script', 'jenkins-job', 'gitlab-manual', 'argocd', 'kubectl')`,
      ),
      check("deploy_targets_config_method", sql`config ->> 'method' = method`),
      check("deploy_targets_config_version", sql`config_version >= 1`),
      check("deploy_targets_server", sql`(method = 'ssh-script') = (server_id is not null)`),
      check("deploy_targets_connection", sql`(method in ('argocd', 'kubectl')) = (connection_id is not null)`),
      index("deploy_targets_environment").on(t.environmentId),
      index("deploy_targets_server_idx").on(t.serverId),
      index("deploy_targets_connection_idx").on(t.connectionId),
      orgScoped("deploy_targets"),
    ],
  )
  .enableRLS();

/**
 * Một lần triển khai. `remote` giữ thư mục, PID và vị trí log đã đọc trên máy chủ (ssh-script) để job theo dõi chạy
 * tiếp sau khi hub khởi động lại; `external` là build/job/application bên ngoài.
 */
export const deploys = hive
  .table(
    "deploys",
    {
      ...identity(),
      targetId: uuid("target_id").notNull(),
      method: text("method").notNull(),
      origin: text("origin").notNull(),
      state: text("state").notNull(),
      version: jsonb("version").$type<DeployVersion>().notNull(),
      requestedBy: text("requested_by"),
      triggeredBy: text("triggered_by"),
      steps: jsonb("steps").$type<DeployStep[]>().notNull().default([]),
      configVersion: integer("config_version"),
      rollbackOf: uuid("rollback_of"),
      skipBackupReason: text("skip_backup_reason"),
      remote: jsonb("remote").$type<Record<string, unknown>>(),
      external: jsonb("external").$type<Record<string, unknown>>(),
      health: jsonb("health").$type<Record<string, unknown>>(),
      approvalsRequired: integer("approvals_required").notNull().default(0),
      approvalExpiresAt: at("approval_expires_at"),
      /** Máy đã chạy lần này (log nằm trên máy đó); null khi chưa giao hoặc chạy kiểu cũ. */
      ranOnWorkerId: uuid("ran_on_worker_id"),
      ranLegacy: boolean("ran_legacy").notNull().default(false),
      ...times(),
      startedAt: at("started_at"),
      finishedAt: at("finished_at"),
    },
    (t) => [
      unique("deploys_id_org").on(t.id, t.orgId),
      // Lịch sử đi theo đích: xoá đích là xoá các lần của nó.
      foreignKey({ columns: [t.targetId, t.orgId], foreignColumns: [deployTargets.id, deployTargets.orgId] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.rollbackOf, t.orgId], foreignColumns: [t.id, t.orgId] }),
      check(
        "deploys_state",
        sql`state in ('pending_approval', 'queued', 'running', 'succeeded', 'failed', 'failed_needs_review', 'unknown',
          'canceled', 'rejected', 'expired')`,
      ),
      check("deploys_origin", sql`origin in ('hive', 'external')`),
      check("deploys_method", sql`method in ('ssh-script', 'jenkins-job', 'gitlab-manual', 'argocd', 'kubectl')`),
      check("deploys_approvals_required", sql`approvals_required between 0 and 5`),
      // Một lần Hive đang đi mỗi đích; lần "ngoài Hive" chỉ là ghi nhận nên không giữ khoá.
      uniqueIndex("deploys_target_in_flight")
        .on(t.targetId)
        .where(sql`origin = 'hive' and state in ('pending_approval', 'queued', 'running')`),
      index("deploys_target_created").on(t.targetId, t.createdAt),
      index("deploys_org_state").on(t.orgId, t.state),
      index("deploys_rollback_of").on(t.rollbackOf),
      orgScoped("deploys"),
    ],
  )
  .enableRLS();

/** Log đã che bí mật. Giữ theo `runLogRetentionDays` của tổ chức qua hive.purge_deploy_logs(). */
export const deployLogChunks = hive
  .table(
    "deploy_log_chunks",
    {
      id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
      orgId: uuid("org_id").notNull(),
      deployId: uuid("deploy_id").notNull(),
      seq: integer("seq").notNull(),
      data: bytea("data").notNull(),
      createdAt: at("created_at").notNull().defaultNow(),
    },
    (t) => [
      unique("deploy_log_chunks_seq").on(t.deployId, t.seq),
      foreignKey({ columns: [t.deployId, t.orgId], foreignColumns: [deploys.id, deploys.orgId] }).onDelete("cascade"),
      index("deploy_log_chunks_org").on(t.orgId),
      orgScoped("deploy_log_chunks"),
      // hive.purge_deploy_logs (SECURITY DEFINER, chạy bằng hive_owner) xoá log quá hạn của mọi tổ chức; hive_app không
      // được gì thêm.
      pgPolicy("deploy_log_chunks_owner_select", { for: "select", to: hiveOwner, using: sql`true` }),
      pgPolicy("deploy_log_chunks_owner_purge", { for: "delete", to: hiveOwner, using: sql`true` }),
    ],
  )
  .enableRLS();

export const deployApprovals = hive
  .table(
    "deploy_approvals",
    {
      ...identity(),
      deployId: uuid("deploy_id").notNull(),
      userId: text("user_id").notNull(),
      decision: text("decision").notNull(),
      reason: text("reason"),
      createdAt: at("created_at").notNull().defaultNow(),
    },
    (t) => [
      unique("deploy_approvals_deploy_user").on(t.deployId, t.userId),
      foreignKey({ columns: [t.deployId, t.orgId], foreignColumns: [deploys.id, deploys.orgId] }).onDelete("cascade"),
      check("deploy_approvals_decision", sql`decision in ('approve', 'reject')`),
      orgScoped("deploy_approvals"),
    ],
  )
  .enableRLS();

/**
 * Việc giao cho worker: hub chỉ giữ cấu hình, trạng thái và lịch sử; log nằm trên máy chạy. `last_seq` để nhận trùng
 * sự kiện (jobId, seq) mà không xử lý hai lần. Tên credential chỉ là tên, không bao giờ là giá trị.
 */
export const deliveryJobs = hive
  .table(
    "delivery_jobs",
    {
      ...identity(),
      deployId: uuid("deploy_id"),
      kind: text("kind").notNull(),
      state: text("state").notNull().default("waiting"),
      workerId: uuid("worker_id"),
      configVersion: integer("config_version"),
      attempt: integer("attempt").notNull().default(1),
      leaseExpiresAt: at("lease_expires_at"),
      lastSeq: integer("last_seq").notNull().default(-1),
      errorCode: text("error_code"),
      errorMessage: text("error_message"),
      credentialNames: text("credential_names").array().notNull().default(sql`'{}'::text[]`),
      ...times(),
      finishedAt: at("finished_at"),
    },
    (t) => [
      unique("delivery_jobs_id_org").on(t.id, t.orgId),
      foreignKey({ columns: [t.deployId, t.orgId], foreignColumns: [deploys.id, deploys.orgId] }).onDelete("cascade"),
      check(
        "delivery_jobs_state",
        sql`state in ('waiting', 'leased', 'running', 'succeeded', 'failed', 'lost', 'canceled')`,
      ),
      check("delivery_jobs_kind", sql`kind in ('jenkins-job', 'argocd')`),
      check("delivery_jobs_attempt", sql`attempt >= 1`),
      check("delivery_jobs_error_message", sql`error_message is null or char_length(error_message) <= 200`),
      index("delivery_jobs_org_state").on(t.orgId, t.state),
      index("delivery_jobs_deploy").on(t.deployId),
      orgScoped("delivery_jobs"),
    ],
  )
  .enableRLS();
