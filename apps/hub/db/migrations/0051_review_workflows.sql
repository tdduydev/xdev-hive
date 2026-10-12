ALTER TYPE "hive"."run_kind" ADD VALUE 'doccheck';--> statement-breakpoint
CREATE TABLE "hive"."review_gate_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"gate_index" integer NOT NULL,
	"gate_id" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"score" double precision,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"decided_by" text,
	"run_id" uuid,
	"due_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "review_gate_runs_status" CHECK (status in ('waiting', 'passed', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "hive"."review_gate_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."review_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"proposal_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_name" text NOT NULL,
	"phases" jsonb NOT NULL,
	"doc_key" text NOT NULL,
	"doc_title" text NOT NULL,
	"gate_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'in_review' NOT NULL,
	"route" text,
	"added_lines" integer DEFAULT 0 NOT NULL,
	"deleted_lines" integer DEFAULT 0 NOT NULL,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_instances_proposal" UNIQUE("proposal_id"),
	CONSTRAINT "review_instances_status" CHECK (status in ('in_review', 'changes_requested', 'approved', 'cancelled')),
	CONSTRAINT "review_instances_scope" CHECK (project_id is null or team_id is not null)
);
--> statement-breakpoint
ALTER TABLE "hive"."review_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."review_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"preset" text NOT NULL,
	"doc_prefixes" text[] NOT NULL,
	"phases" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."review_workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "capabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."review_gate_runs" ADD CONSTRAINT "review_gate_runs_instance_id_review_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "hive"."review_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."review_instances" ADD CONSTRAINT "review_instances_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "hive"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."review_instances" ADD CONSTRAINT "review_instances_workflow_id_review_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "hive"."review_workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_gate_runs_instance" ON "hive"."review_gate_runs" USING btree ("instance_id","started_at");--> statement-breakpoint
CREATE INDEX "review_gate_runs_due" ON "hive"."review_gate_runs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "review_instances_org_status" ON "hive"."review_instances" USING btree ("org_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_instances_doc" ON "hive"."review_instances" USING btree ("org_id","doc_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "review_gate_runs_rw" ON "hive"."review_gate_runs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "review_gate_runs_owner_select" ON "hive"."review_gate_runs" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "review_instances_rw" ON "hive"."review_instances" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "review_workflows_rw" ON "hive"."review_workflows" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."review_workflows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."review_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."review_gate_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tổ chức có gate người duyệt quá hạn chưa nhắc. Job nhắc hạn chạy không có tổ chức trong context nên cần SECURITY
-- DEFINER; hàm chỉ trả id tổ chức, việc đọc phiên duyệt và gửi thông báo chạy lại trong từng tổ chức.
CREATE FUNCTION hive.review_overdue_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT r.org_id FROM hive.review_gate_runs AS r
  WHERE r.status = 'waiting' AND r.due_at < now() AND r.overdue_notified_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.review_overdue_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.review_overdue_orgs() TO hive_app;
