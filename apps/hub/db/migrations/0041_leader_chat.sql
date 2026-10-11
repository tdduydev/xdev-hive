CREATE TYPE "hive"."leader_approval_state" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "hive"."leader_chat_role" AS ENUM('user', 'leader', 'system');--> statement-breakpoint
ALTER TYPE "hive"."run_kind" ADD VALUE 'leader';--> statement-breakpoint
CREATE TABLE "hive"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"status" "hive"."leader_approval_state" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "hive"."leader_chat_role" NOT NULL,
	"content" text NOT NULL,
	"sender_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_threads_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."runs" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "leader_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."approvals" ADD CONSTRAINT "approvals_thread_id_org_id_chat_threads_id_org_id_fk" FOREIGN KEY ("thread_id","org_id") REFERENCES "hive"."chat_threads"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."chat_messages" ADD CONSTRAINT "chat_messages_thread_id_org_id_chat_threads_id_org_id_fk" FOREIGN KEY ("thread_id","org_id") REFERENCES "hive"."chat_threads"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_org_status_expiry" ON "hive"."approvals" USING btree ("org_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_created" ON "hive"."chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_threads_org_updated" ON "hive"."chat_threads" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_leader_thread_active" ON "hive"."runs" USING btree ("leader_thread_id") WHERE kind = 'leader' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');--> statement-breakpoint
CREATE POLICY "approvals_rw" ON "hive"."approvals" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_messages_rw" ON "hive"."chat_messages" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_threads_rw" ON "hive"."chat_threads" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE hive.chat_threads ADD CONSTRAINT chat_threads_project_id_org_fk
  FOREIGN KEY (project_id, org_id) REFERENCES hive.projects (id, org_id) ON DELETE SET NULL (project_id);
--> statement-breakpoint
ALTER TABLE hive.approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE hive.chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE hive.chat_threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.approvals, hive.chat_messages, hive.chat_threads FROM hive_app;