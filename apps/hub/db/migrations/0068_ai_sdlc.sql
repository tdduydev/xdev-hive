ALTER TYPE "hive"."run_kind" ADD VALUE 'sdlc';--> statement-breakpoint
ALTER TYPE "hive"."team_role" ADD VALUE 'ba';--> statement-breakpoint
CREATE TABLE "hive"."sdlc_artifact_syncs" (
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"repo_path" text NOT NULL,
	"synced_version" integer,
	"synced_commit" text,
	"synced_hash" text,
	"repo_hash" text,
	"sync_state" text DEFAULT 'none' NOT NULL,
	"sync_error" text,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "sdlc_artifact_syncs_artifact_id_project_id_pk" PRIMARY KEY("artifact_id","project_id"),
	CONSTRAINT "sdlc_artifact_syncs_kind" CHECK (kind in ('source', 'copy')),
	CONSTRAINT "sdlc_artifact_syncs_state" CHECK (sync_state in ('none', 'pending', 'synced', 'failed', 'drifted', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifact_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"required" boolean NOT NULL,
	"scope" text DEFAULT 'item' NOT NULL,
	"instance" text DEFAULT '' NOT NULL,
	"consumer_project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"contract_format" text,
	"doc_key" text NOT NULL,
	"repo_path" text NOT NULL,
	"baseline_version" integer,
	"baseline_hash" text,
	"approval" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "sdlc_artifacts_doc_key" UNIQUE("doc_key"),
	CONSTRAINT "sdlc_artifacts_item_artifact" UNIQUE("item_id","artifact_id","instance"),
	CONSTRAINT "sdlc_artifacts_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "sdlc_artifacts_scope" CHECK (scope in ('item', 'project', 'contract')),
	CONSTRAINT "sdlc_artifacts_approval" CHECK (approval in ('none', 'human', 'auto', 'revoked', 'reaffirmed'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_auto_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"gate_id" text NOT NULL,
	"proposal_id" uuid,
	"version" integer,
	"score" numeric(4, 2) NOT NULL,
	"threshold" numeric(4, 2) NOT NULL,
	"reasons" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revocable_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"rereview_id" uuid,
	CONSTRAINT "sdlc_auto_approvals_gate" UNIQUE("review_id","gate_id"),
	CONSTRAINT "sdlc_auto_approvals_revoke" CHECK (revoked_at IS NULL OR char_length(revoke_reason) >= 10)
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_auto_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_item_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase_index" integer NOT NULL,
	"phase_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"decided_by" text,
	"started_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	CONSTRAINT "sdlc_item_phases_item_index" UNIQUE("item_id","phase_index"),
	CONSTRAINT "sdlc_item_phases_status" CHECK (status in ('pending', 'drafting', 'awaiting_answers', 'in_review', 'approved', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_phases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_item_projects" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" text NOT NULL,
	"settings" jsonb NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "sdlc_item_projects_item_id_project_id_pk" PRIMARY KEY("item_id","project_id"),
	CONSTRAINT "sdlc_item_projects_role" CHECK (role in ('home', 'participant'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_item_tasks" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slice_key" text NOT NULL,
	"wave" integer NOT NULL,
	"requirement_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"breakdown_version" integer NOT NULL,
	CONSTRAINT "sdlc_item_tasks_item_id_task_id_pk" PRIMARY KEY("item_id","task_id"),
	CONSTRAINT "sdlc_item_tasks_slice" UNIQUE("item_id","slice_key")
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"idea" text NOT NULL,
	"source" jsonb NOT NULL,
	"mode_ref" text NOT NULL,
	"mode" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"size_suggested" text,
	"size" text NOT NULL,
	"suggestion" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"phase_index" integer DEFAULT 0 NOT NULL,
	"converge_round" integer DEFAULT 0 NOT NULL,
	"converged_at" timestamp with time zone,
	"owner_user_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "sdlc_items_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "sdlc_items_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "sdlc_items_status" CHECK (status in ('active', 'paused', 'done', 'cancelled')),
	CONSTRAINT "sdlc_items_size" CHECK (size in ('S', 'M', 'L', 'XL'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_modes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"method" text NOT NULL,
	"base_preset" text,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdlc_modes_org_slug" UNIQUE("org_id","slug")
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_modes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"reason" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "sdlc_overrides_reason" CHECK (char_length(reason) >= 10)
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase_id" text NOT NULL,
	"step_id" uuid,
	"run_id" uuid,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended" text,
	"context" text,
	"answer" text,
	"used_recommended" boolean DEFAULT false NOT NULL,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdlc_questions_status" CHECK (status in ('open', 'answered', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase_id" text NOT NULL,
	"step_id" text NOT NULL,
	"action" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"instructions" text,
	"result" jsonb,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sdlc_steps_status" CHECK (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sdlc_trace_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"requirement_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"run_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdlc_trace_links_ref" UNIQUE("item_id","requirement_id","kind","ref"),
	CONSTRAINT "sdlc_trace_links_kind" CHECK (kind in ('task', 'run', 'pr', 'commit', 'test', 'ci', 'finding'))
);
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_trace_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."task_dependencies" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_id_pk" PRIMARY KEY("task_id","depends_on_id"),
	CONSTRAINT "task_dependencies_self" CHECK (task_id <> depends_on_id)
);
--> statement-breakpoint
ALTER TABLE "hive"."task_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "required_labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."tasks" ADD COLUMN "checklist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifact_syncs" ADD CONSTRAINT "sdlc_artifact_syncs_artifact_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."sdlc_artifacts"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifacts" ADD CONSTRAINT "sdlc_artifacts_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_auto_approvals" ADD CONSTRAINT "sdlc_auto_approvals_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_auto_approvals" ADD CONSTRAINT "sdlc_auto_approvals_artifact_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."sdlc_artifacts"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_phases" ADD CONSTRAINT "sdlc_item_phases_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_projects" ADD CONSTRAINT "sdlc_item_projects_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_tasks" ADD CONSTRAINT "sdlc_item_tasks_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_overrides" ADD CONSTRAINT "sdlc_overrides_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_questions" ADD CONSTRAINT "sdlc_questions_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_steps" ADD CONSTRAINT "sdlc_steps_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."sdlc_trace_links" ADD CONSTRAINT "sdlc_trace_links_item_fk" FOREIGN KEY ("item_id","org_id") REFERENCES "hive"."sdlc_items"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."task_dependencies" ADD CONSTRAINT "task_dependencies_task_fk" FOREIGN KEY ("task_id","org_id") REFERENCES "hive"."tasks"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_fk" FOREIGN KEY ("depends_on_id","org_id") REFERENCES "hive"."tasks"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sdlc_artifact_syncs_repo" ON "hive"."sdlc_artifact_syncs" USING btree ("project_id","repo_path");--> statement-breakpoint
CREATE INDEX "sdlc_auto_approvals_item" ON "hive"."sdlc_auto_approvals" USING btree ("item_id","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_item_projects_home" ON "hive"."sdlc_item_projects" USING btree ("item_id") WHERE role = 'home';--> statement-breakpoint
CREATE INDEX "sdlc_item_projects_team" ON "hive"."sdlc_item_projects" USING btree ("org_id","team_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "sdlc_item_projects_project" ON "hive"."sdlc_item_projects" USING btree ("project_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_item_tasks_task" ON "hive"."sdlc_item_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "sdlc_items_board" ON "hive"."sdlc_items" USING btree ("org_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_items_issue" ON "hive"."sdlc_items" USING btree ("project_id",(source->>'issueNumber')) WHERE source->>'kind' = 'issue';--> statement-breakpoint
CREATE INDEX "sdlc_overrides_active" ON "hive"."sdlc_overrides" USING btree ("item_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "sdlc_questions_open" ON "hive"."sdlc_questions" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sdlc_steps_item" ON "hive"."sdlc_steps" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sdlc_steps_run" ON "hive"."sdlc_steps" USING btree ("run_id") WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_dependencies_rev" ON "hive"."task_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE POLICY "sdlc_artifact_syncs_rw" ON "hive"."sdlc_artifact_syncs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_artifacts_rw" ON "hive"."sdlc_artifacts" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_auto_approvals_rw" ON "hive"."sdlc_auto_approvals" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_item_phases_rw" ON "hive"."sdlc_item_phases" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_item_projects_rw" ON "hive"."sdlc_item_projects" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_item_tasks_rw" ON "hive"."sdlc_item_tasks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_items_rw" ON "hive"."sdlc_items" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_items_owner_select" ON "hive"."sdlc_items" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "sdlc_modes_rw" ON "hive"."sdlc_modes" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_overrides_rw" ON "hive"."sdlc_overrides" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_questions_rw" ON "hive"."sdlc_questions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_steps_rw" ON "hive"."sdlc_steps" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sdlc_trace_links_rw" ON "hive"."sdlc_trace_links" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "task_dependencies_rw" ON "hive"."task_dependencies" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- Khoá ngoại tới tasks (bảng của module khác) viết tay. Khoá kép theo tổ chức vì khoá ngoại bỏ qua RLS.
ALTER TABLE "hive"."sdlc_item_tasks" ADD CONSTRAINT "sdlc_item_tasks_task_fk" FOREIGN KEY ("task_id","org_id") REFERENCES "hive"."tasks"("id","org_id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_overrides" ADD CONSTRAINT "sdlc_overrides_task_fk" FOREIGN KEY ("task_id","org_id") REFERENCES "hive"."tasks"("id","org_id") ON DELETE cascade;
--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."task_dependencies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_modes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_phases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_artifact_syncs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_questions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_item_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_trace_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."sdlc_auto_approvals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tổ chức có hạng mục đang chạy. Job nhắc câu hỏi quá hạn và quét đồng bộ chạy không có tổ chức trong context nên cần
-- SECURITY DEFINER; hàm chỉ trả id tổ chức, việc đọc hạng mục chạy lại trong từng tổ chức.
CREATE FUNCTION hive.sdlc_active_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT i.org_id FROM hive.sdlc_items AS i WHERE i.status = 'active'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.sdlc_active_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.sdlc_active_orgs() TO hive_app;
