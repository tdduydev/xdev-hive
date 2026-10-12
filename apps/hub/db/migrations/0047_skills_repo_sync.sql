-- Webhook của kho skill (/hooks/skills/{id}) đến không có phiên nên chưa biết tổ chức. Module knowledge đặt id kho vào
-- app.webhook_skill_repo_id trong transaction; policy skill_repos_webhook cho thấy đúng dòng đó, giống
-- ctx_webhook_project của dự án. Không dùng SECURITY DEFINER vì bảng bị FORCE RLS.
CREATE FUNCTION hive.ctx_webhook_skill_repo() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.webhook_skill_repo_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE TYPE "hive"."skill_repo_status" AS ENUM('idle', 'syncing', 'ok', 'failed');--> statement-breakpoint
CREATE TABLE "hive"."skill_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"webhook_id" text,
	"webhook_url" text,
	"status" "hive"."skill_repo_status" DEFAULT 'idle' NOT NULL,
	"last_sha" text,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"configured_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_repos_org" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."skill_repos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."proposals" ADD COLUMN "git_pr_number" integer;--> statement-breakpoint
ALTER TABLE "hive"."proposals" ADD COLUMN "git_pr_url" text;--> statement-breakpoint
ALTER TABLE "hive"."skills" ADD COLUMN "repo_path" text;--> statement-breakpoint
ALTER TABLE "hive"."skills" ADD COLUMN "repo_version" integer;--> statement-breakpoint
CREATE POLICY "skill_repos_rw" ON "hive"."skill_repos" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "skill_repos_webhook" ON "hive"."skill_repos" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id = hive.ctx_webhook_skill_repo());--> statement-breakpoint
ALTER TABLE "hive"."skill_repos" FORCE ROW LEVEL SECURITY;
