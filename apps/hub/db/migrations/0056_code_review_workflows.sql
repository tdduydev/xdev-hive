CREATE TABLE "hive"."code_review_gate_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"gate_index" integer NOT NULL,
	"gate_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"score" double precision,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_ids" uuid[] DEFAULT '{}' NOT NULL,
	"note" text,
	"decided_by" text,
	"overridden" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "code_review_gate_runs_status" CHECK (status in ('waiting', 'passed', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "hive"."code_review_gate_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."code_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_name" text NOT NULL,
	"phases" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"previous_id" uuid,
	"gate_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'in_review' NOT NULL,
	"route" text,
	"resume_gate_index" integer,
	"requester_user_id" text,
	"agent_revisions" integer DEFAULT 0 NOT NULL,
	"added_lines" integer DEFAULT 0 NOT NULL,
	"deleted_lines" integer DEFAULT 0 NOT NULL,
	"changed_files" integer DEFAULT 0 NOT NULL,
	"run_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_reviews_status" CHECK (status in ('in_review', 'changes_requested', 'approved', 'merged', 'cancelled', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "hive"."code_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."review_workflows" ADD COLUMN "subject" text DEFAULT 'doc' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."review_workflows" ADD COLUMN "code" jsonb;--> statement-breakpoint
ALTER TABLE "hive"."code_review_gate_runs" ADD CONSTRAINT "code_review_gate_runs_review_id_code_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "hive"."code_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."code_reviews" ADD CONSTRAINT "code_reviews_previous_id_code_reviews_id_fk" FOREIGN KEY ("previous_id") REFERENCES "hive"."code_reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_review_gate_runs_review" ON "hive"."code_review_gate_runs" USING btree ("review_id","started_at");--> statement-breakpoint
CREATE INDEX "code_review_gate_runs_due" ON "hive"."code_review_gate_runs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "code_review_gate_runs_runs" ON "hive"."code_review_gate_runs" USING gin ("run_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "code_reviews_open_pr" ON "hive"."code_reviews" USING btree ("project_id","pr_number") WHERE status in ('in_review', 'changes_requested', 'approved');--> statement-breakpoint
CREATE INDEX "code_reviews_org_status" ON "hive"."code_reviews" USING btree ("org_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "code_reviews_run" ON "hive"."code_reviews" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "hive"."review_workflows" ADD CONSTRAINT "review_workflows_subject" CHECK (subject in ('doc', 'code'));--> statement-breakpoint
ALTER TABLE "hive"."review_workflows" ADD CONSTRAINT "review_workflows_code" CHECK ((subject = 'code') = (code is not null));--> statement-breakpoint
CREATE POLICY "code_review_gate_runs_rw" ON "hive"."code_review_gate_runs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "code_review_gate_runs_owner_select" ON "hive"."code_review_gate_runs" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "code_reviews_rw" ON "hive"."code_reviews" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."code_reviews" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."code_review_gate_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tổ chức có checkpoint review code quá hạn chưa nhắc. Job nhắc hạn chạy không có tổ chức trong context nên cần SECURITY
-- DEFINER; hàm chỉ trả id tổ chức, việc đọc phiên và gửi thông báo chạy lại trong từng tổ chức.
CREATE FUNCTION hive.code_review_overdue_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT r.org_id FROM hive.code_review_gate_runs AS r
  WHERE r.status = 'waiting' AND r.due_at < now() AND r.overdue_notified_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.code_review_overdue_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.code_review_overdue_orgs() TO hive_app;
