CREATE TABLE "hive"."delivery_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"deploy_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"worker_id" uuid,
	"config_version" integer,
	"attempt" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_seq" integer DEFAULT -1 NOT NULL,
	"error_code" text,
	"error_message" text,
	"credential_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "delivery_jobs_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "delivery_jobs_state" CHECK (state in ('waiting', 'leased', 'running', 'succeeded', 'failed', 'lost', 'canceled')),
	CONSTRAINT "delivery_jobs_kind" CHECK (kind in ('ssh-script', 'jenkins-job', 'gitlab-manual', 'argocd', 'kubectl', 'health', 'ci-action')),
	CONSTRAINT "delivery_jobs_attempt" CHECK (attempt >= 1),
	CONSTRAINT "delivery_jobs_error_message" CHECK (error_message is null or char_length(error_message) <= 200)
);
--> statement-breakpoint
ALTER TABLE "hive"."delivery_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ADD COLUMN "runner" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ADD COLUMN "runner_machines" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ADD COLUMN "runner_label_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."deploys" ADD COLUMN "ran_on_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."deploys" ADD COLUMN "ran_legacy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."delivery_jobs" ADD CONSTRAINT "delivery_jobs_deploy_id_org_id_deploys_id_org_id_fk" FOREIGN KEY ("deploy_id","org_id") REFERENCES "hive"."deploys"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_jobs_org_state" ON "hive"."delivery_jobs" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "delivery_jobs_deploy" ON "hive"."delivery_jobs" USING btree ("deploy_id");--> statement-breakpoint
ALTER TABLE "hive"."deploy_environments" ADD CONSTRAINT "deploy_environments_runner" CHECK (runner in ('worker', 'legacy'));--> statement-breakpoint
CREATE POLICY "delivery_jobs_rw" ON "hive"."delivery_jobs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- Môi trường có trước bản này đang chạy theo cách cũ (hub tự gọi): giữ nguyên cho tới khi người dùng chuyển sang worker.
-- Chủ bảng cũng chịu FORCE RLS; chỉ tắt FORCE trong transaction migration để điền mọi tổ chức.
ALTER TABLE hive.deploy_environments NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE hive.deploy_environments SET runner = 'legacy';
--> statement-breakpoint
ALTER TABLE hive.deploy_environments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.deploys NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE hive.deploys SET ran_legacy = true;
--> statement-breakpoint
ALTER TABLE hive.deploys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.delivery_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.delivery_jobs TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.delivery_jobs FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.delivery_jobs ADD CONSTRAINT delivery_jobs_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
