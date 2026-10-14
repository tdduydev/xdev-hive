ALTER TYPE "hive"."run_kind" ADD VALUE 'skill_proposal';--> statement-breakpoint
CREATE TABLE "hive"."learned_skill_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"reason" text NOT NULL,
	"scope_team_id" uuid,
	"scope_project_id" uuid,
	"base_version" integer DEFAULT 0 NOT NULL,
	"triggers" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"delivery_mode" text,
	"pr_number" integer,
	"pr_url" text,
	"delivery_error" text,
	"result_skill_id" uuid,
	"result_version" integer,
	CONSTRAINT "learned_skill_proposals_kind" CHECK (kind in ('new', 'edit')),
	CONSTRAINT "learned_skill_proposals_status" CHECK (status in ('pending', 'approved', 'rejected')),
	CONSTRAINT "learned_skill_proposals_delivery" CHECK (delivery_mode is null or delivery_mode in ('pr', 'saved')),
	CONSTRAINT "learned_skill_proposals_scope" CHECK (scope_project_id is null or scope_team_id is not null)
);
--> statement-breakpoint
ALTER TABLE "hive"."learned_skill_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."skill_learning_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"run_id" uuid,
	"candidates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "skill_learning_batches_project_day" UNIQUE("project_id","day"),
	CONSTRAINT "skill_learning_batches_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "skill_learning_batches_status" CHECK (status in ('running', 'done', 'failed', 'empty'))
);
--> statement-breakpoint
ALTER TABLE "hive"."skill_learning_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."skill_learning_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"marked_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_learning_marks_run" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."skill_learning_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."learned_skill_proposals" ADD CONSTRAINT "learned_skill_proposals_batch_id_org_id_skill_learning_batches_id_org_id_fk" FOREIGN KEY ("batch_id","org_id") REFERENCES "hive"."skill_learning_batches"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learned_skill_proposals_org_status" ON "hive"."learned_skill_proposals" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "learned_skill_proposals_project" ON "hive"."learned_skill_proposals" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "skill_learning_batches_org_created" ON "hive"."skill_learning_batches" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "learned_skill_proposals_rw" ON "hive"."learned_skill_proposals" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "skill_learning_batches_rw" ON "hive"."skill_learning_batches" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "skill_learning_batches_owner_select" ON "hive"."skill_learning_batches" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "skill_learning_marks_rw" ON "hive"."skill_learning_marks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- Viết tay: projects và runs là bảng của module khác, schema.ts của skilllearn không import được.
ALTER TABLE "hive"."skill_learning_batches" ADD CONSTRAINT "skill_learning_batches_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."learned_skill_proposals" ADD CONSTRAINT "learned_skill_proposals_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."learned_skill_proposals" ADD CONSTRAINT "learned_skill_proposals_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."skill_learning_marks" ADD CONSTRAINT "skill_learning_marks_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."skill_learning_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."skill_learning_marks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."learned_skill_proposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Tổ chức bật học skill (Chính sách agent) hoặc còn lô đang chạy chờ nhận kết quả. Job hẹn giờ chạy không có tổ chức
-- trong context nên cần SECURITY DEFINER; hàm chỉ trả id tổ chức, phần còn lại chạy lại trong từng tổ chức.
CREATE FUNCTION hive.skill_learning_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.org_id FROM hive.agent_policies AS p WHERE p.policy #>> '{skillLearning,enabled}' = 'true'
  UNION
  SELECT b.org_id FROM hive.skill_learning_batches AS b WHERE b.status = 'running'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.skill_learning_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.skill_learning_orgs() TO hive_app;
