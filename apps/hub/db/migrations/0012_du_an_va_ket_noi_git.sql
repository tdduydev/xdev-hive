CREATE TYPE "hive"."project_state" AS ENUM('provisioning', 'active', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "hive"."provision_step_kind" AS ENUM('check-access', 'create-repo', 'link-repo', 'commit-template', 'protect-branch', 'add-webhook');--> statement-breakpoint
CREATE TYPE "hive"."provision_step_state" AS ENUM('pending', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "hive"."project_repo_mode" AS ENUM('new', 'existing');--> statement-breakpoint
CREATE TYPE "hive"."scm_kind" AS ENUM('github', 'gitlab');--> statement-breakpoint
CREATE TABLE "hive"."project_provision_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "hive"."provision_step_kind" NOT NULL,
	"target" text,
	"state" "hive"."provision_step_state" DEFAULT 'pending' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "project_provision_steps_position" UNIQUE("project_id","position")
);
--> statement-breakpoint
ALTER TABLE "hive"."project_provision_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"scm_connection_id" uuid NOT NULL,
	"scm_kind" text NOT NULL,
	"repo_mode" "hive"."project_repo_mode" NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"repo_visibility" text,
	"default_branch" text,
	"repo_external_id" text,
	"repo_http_url" text,
	"repo_ssh_url" text,
	"repo_web_url" text,
	"state" "hive"."project_state" DEFAULT 'provisioning' NOT NULL,
	"settings" jsonb NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"webhook_secret_enc" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_org_key" UNIQUE("org_id","key"),
	CONSTRAINT "projects_org_idempotency" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "projects_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."scm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "hive"."scm_kind" NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"default_owner" text,
	"app_id" text,
	"installation_id" integer,
	"secret_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_connections_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "scm_connections_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."scm_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."project_provision_steps" ADD CONSTRAINT "project_provision_steps_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_provision_steps_org" ON "hive"."project_provision_steps" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_repo" ON "hive"."projects" USING btree ("scm_connection_id",lower("repo_owner"),lower("repo_name"));--> statement-breakpoint
CREATE INDEX "projects_org_team" ON "hive"."projects" USING btree ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "projects_system" ON "hive"."projects" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "scm_connections_org" ON "hive"."scm_connections" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "project_provision_steps_rw" ON "hive"."project_provision_steps" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "projects_rw" ON "hive"."projects" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "scm_connections_rw" ON "hive"."scm_connections" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());