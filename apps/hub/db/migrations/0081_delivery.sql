CREATE TABLE "hive"."ci_jenkins_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"watcher_user_id" text,
	"last_poll_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_jenkins_connections_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "ci_jenkins_connections_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."ci_jenkins_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."ci_jenkins_user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"jenkins_user" text NOT NULL,
	"token_enc" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_ok" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_jenkins_user_tokens_connection_user" UNIQUE("connection_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."ci_jenkins_user_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."ci_project_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"job_path" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_project_jobs_project_job" UNIQUE("project_id","connection_id","job_path")
);
--> statement-breakpoint
ALTER TABLE "hive"."ci_project_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."ci_runs_seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"status" text NOT NULL,
	"branch" text,
	"finished_at" timestamp with time zone,
	"notified_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_runs_seen_source_external" UNIQUE("org_id","source","external_id"),
	CONSTRAINT "ci_runs_seen_source" CHECK (source in ('gitlab', 'github', 'jenkins'))
);
--> statement-breakpoint
ALTER TABLE "hive"."ci_runs_seen" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"deploy_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_approvals_deploy_user" UNIQUE("deploy_id","user_id"),
	CONSTRAINT "deploy_approvals_decision" CHECK (decision in ('approve', 'reject'))
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"ca_pem" text,
	"token_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_connections_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "deploy_connections_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "deploy_connections_kind" CHECK (kind in ('argocd', 'kubernetes'))
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"policy" jsonb NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lock_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_environments_system_name" UNIQUE("system_id","name"),
	CONSTRAINT "deploy_environments_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "deploy_environments_lock" CHECK ((locked_at is null) = (lock_reason is null)),
	CONSTRAINT "deploy_environments_policy" CHECK (jsonb_typeof(policy) = 'object')
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_log_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hive"."deploy_log_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"deploy_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_log_chunks_seq" UNIQUE("deploy_id","seq")
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_log_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"private_key_enc" text NOT NULL,
	"public_key" text NOT NULL,
	"pending_private_key_enc" text,
	"pending_public_key" text,
	"pending_key_created_at" timestamp with time zone,
	"host_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_servers_team_name" UNIQUE("team_id","name"),
	CONSTRAINT "deploy_servers_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "deploy_servers_port" CHECK (port between 1 and 65535),
	CONSTRAINT "deploy_servers_pending_key" CHECK ((pending_private_key_enc is null) = (pending_public_key is null)
          and (pending_private_key_enc is null) = (pending_key_created_at is null)),
	CONSTRAINT "deploy_servers_host_keys" CHECK (jsonb_typeof(host_keys) = 'array')
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_servers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploy_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"method" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"server_id" uuid,
	"connection_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_targets_project_environment" UNIQUE("project_id","environment_id"),
	CONSTRAINT "deploy_targets_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "deploy_targets_method" CHECK (method in ('ssh-script', 'jenkins-job', 'gitlab-manual', 'argocd', 'kubectl')),
	CONSTRAINT "deploy_targets_config_method" CHECK (config ->> 'method' = method),
	CONSTRAINT "deploy_targets_config_version" CHECK (config_version >= 1),
	CONSTRAINT "deploy_targets_server" CHECK ((method = 'ssh-script') = (server_id is not null)),
	CONSTRAINT "deploy_targets_connection" CHECK ((method in ('argocd', 'kubectl')) = (connection_id is not null))
);
--> statement-breakpoint
ALTER TABLE "hive"."deploy_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."deploys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"method" text NOT NULL,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"version" jsonb NOT NULL,
	"requested_by" text,
	"triggered_by" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_version" integer,
	"rollback_of" uuid,
	"skip_backup_reason" text,
	"remote" jsonb,
	"external" jsonb,
	"health" jsonb,
	"approvals_required" integer DEFAULT 0 NOT NULL,
	"approval_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "deploys_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "deploys_state" CHECK (state in ('pending_approval', 'queued', 'running', 'succeeded', 'failed', 'failed_needs_review', 'unknown',
          'canceled', 'rejected', 'expired')),
	CONSTRAINT "deploys_origin" CHECK (origin in ('hive', 'external')),
	CONSTRAINT "deploys_method" CHECK (method in ('ssh-script', 'jenkins-job', 'gitlab-manual', 'argocd', 'kubectl')),
	CONSTRAINT "deploys_approvals_required" CHECK (approvals_required between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "hive"."deploys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."notification_channels" ADD COLUMN "system_ids" uuid[];--> statement-breakpoint
ALTER TABLE "hive"."ci_jenkins_user_tokens" ADD CONSTRAINT "ci_jenkins_user_tokens_connection_id_org_id_ci_jenkins_connections_id_org_id_fk" FOREIGN KEY ("connection_id","org_id") REFERENCES "hive"."ci_jenkins_connections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."ci_project_jobs" ADD CONSTRAINT "ci_project_jobs_connection_id_org_id_ci_jenkins_connections_id_org_id_fk" FOREIGN KEY ("connection_id","org_id") REFERENCES "hive"."ci_jenkins_connections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_approvals" ADD CONSTRAINT "deploy_approvals_deploy_id_org_id_deploys_id_org_id_fk" FOREIGN KEY ("deploy_id","org_id") REFERENCES "hive"."deploys"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ADD CONSTRAINT "deploy_environments_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_log_chunks" ADD CONSTRAINT "deploy_log_chunks_deploy_id_org_id_deploys_id_org_id_fk" FOREIGN KEY ("deploy_id","org_id") REFERENCES "hive"."deploys"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_servers" ADD CONSTRAINT "deploy_servers_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_targets" ADD CONSTRAINT "deploy_targets_environment_id_org_id_deploy_environments_id_org_id_fk" FOREIGN KEY ("environment_id","org_id") REFERENCES "hive"."deploy_environments"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_targets" ADD CONSTRAINT "deploy_targets_server_id_org_id_deploy_servers_id_org_id_fk" FOREIGN KEY ("server_id","org_id") REFERENCES "hive"."deploy_servers"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploy_targets" ADD CONSTRAINT "deploy_targets_connection_id_org_id_deploy_connections_id_org_id_fk" FOREIGN KEY ("connection_id","org_id") REFERENCES "hive"."deploy_connections"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploys" ADD CONSTRAINT "deploys_target_id_org_id_deploy_targets_id_org_id_fk" FOREIGN KEY ("target_id","org_id") REFERENCES "hive"."deploy_targets"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."deploys" ADD CONSTRAINT "deploys_rollback_of_org_id_deploys_id_org_id_fk" FOREIGN KEY ("rollback_of","org_id") REFERENCES "hive"."deploys"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_project_jobs_connection" ON "hive"."ci_project_jobs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ci_runs_seen_project" ON "hive"."ci_runs_seen" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "deploy_log_chunks_org" ON "hive"."deploy_log_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "deploy_targets_environment" ON "hive"."deploy_targets" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "deploy_targets_server_idx" ON "hive"."deploy_targets" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "deploy_targets_connection_idx" ON "hive"."deploy_targets" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_target_in_flight" ON "hive"."deploys" USING btree ("target_id") WHERE origin = 'hive' and state in ('pending_approval', 'queued', 'running');--> statement-breakpoint
CREATE INDEX "deploys_target_created" ON "hive"."deploys" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "deploys_org_state" ON "hive"."deploys" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "deploys_rollback_of" ON "hive"."deploys" USING btree ("rollback_of");--> statement-breakpoint
CREATE POLICY "ci_jenkins_connections_rw" ON "hive"."ci_jenkins_connections" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "ci_jenkins_user_tokens_rw" ON "hive"."ci_jenkins_user_tokens" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "ci_project_jobs_rw" ON "hive"."ci_project_jobs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "ci_runs_seen_rw" ON "hive"."ci_runs_seen" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_approvals_rw" ON "hive"."deploy_approvals" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_connections_rw" ON "hive"."deploy_connections" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_environments_rw" ON "hive"."deploy_environments" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_log_chunks_rw" ON "hive"."deploy_log_chunks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_log_chunks_owner_select" ON "hive"."deploy_log_chunks" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "deploy_log_chunks_owner_purge" ON "hive"."deploy_log_chunks" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "deploy_servers_rw" ON "hive"."deploy_servers" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploy_targets_rw" ON "hive"."deploy_targets" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "deploys_rw" ON "hive"."deploys" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- Khóa ngoại cũng kiểm org_id vì kiểm tham chiếu không chịu RLS.
ALTER TABLE hive.ci_jenkins_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.ci_jenkins_connections TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.ci_jenkins_connections FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.ci_jenkins_connections ADD CONSTRAINT ci_jenkins_connections_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.ci_jenkins_user_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.ci_jenkins_user_tokens TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.ci_jenkins_user_tokens FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.ci_jenkins_user_tokens ADD CONSTRAINT ci_jenkins_user_tokens_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_connections TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_connections FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_connections ADD CONSTRAINT deploy_connections_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.ci_project_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.ci_project_jobs TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.ci_project_jobs FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.ci_project_jobs ADD CONSTRAINT ci_project_jobs_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.ci_runs_seen FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.ci_runs_seen TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.ci_runs_seen FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.ci_runs_seen ADD CONSTRAINT ci_runs_seen_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_servers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_servers TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_servers FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_servers ADD CONSTRAINT deploy_servers_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_environments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_environments TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_environments FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_environments ADD CONSTRAINT deploy_environments_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_targets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_targets TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_targets FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_targets ADD CONSTRAINT deploy_targets_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploys TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploys FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploys ADD CONSTRAINT deploys_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_log_chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_log_chunks TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_log_chunks FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_log_chunks ADD CONSTRAINT deploy_log_chunks_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.deploy_approvals TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.deploy_approvals FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.deploy_approvals ADD CONSTRAINT deploy_approvals_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Dự án và hệ thống nằm ở catalog/tenancy; khóa ngoại viết tay để schema.ts không import chéo module.
ALTER TABLE hive.ci_project_jobs ADD CONSTRAINT ci_project_jobs_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.ci_runs_seen ADD CONSTRAINT ci_runs_seen_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.deploy_targets ADD CONSTRAINT deploy_targets_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
-- systems không có unique (id, org_id), chỉ có (id, team_id); môi trường đi qua đội, đội đã gắn với tổ chức ở khóa
-- ngoại tới teams. Hệ thống chuyển đội thì môi trường đi theo.
ALTER TABLE hive.deploy_environments ADD CONSTRAINT deploy_environments_system_id_team_fk FOREIGN KEY (system_id, team_id) REFERENCES hive.systems(id, team_id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
-- Xoá log triển khai cũ hơn số ngày giữ log run của từng tổ chức (Chính sách agent; chưa có thì 365 ngày, ít nhất 30).
-- Job không có tổ chức trong context nên cần SECURITY DEFINER; hàm chỉ xoá, không đọc được gì.
CREATE FUNCTION hive.purge_deploy_logs() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.deploy_log_chunks l
    WHERE l.created_at < now() - make_interval(days => greatest(30, coalesce(
      (SELECT (p.policy -> 'limits' ->> 'runLogRetentionDays')::int FROM hive.agent_policies p WHERE p.org_id = l.org_id),
      365
    )))
    RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_deploy_logs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_deploy_logs() TO hive_app;
