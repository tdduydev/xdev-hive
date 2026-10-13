ALTER TYPE "hive"."run_kind" ADD VALUE 'brief';--> statement-breakpoint
CREATE TABLE "hive"."project_briefs" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"commit_sha" text,
	"source" text NOT NULL,
	"updated_by_user_id" text,
	"updated_by_run_id" uuid,
	"head_sha" text,
	"commits_behind" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_briefs_content_len" CHECK (char_length(content) between 1 and 12000),
	CONSTRAINT "project_briefs_source" CHECK (source in ('agent', 'user')),
	CONSTRAINT "project_briefs_updated_by" CHECK ((updated_by_user_id is null) <> (updated_by_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."project_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "explore" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_brief_active" ON "hive"."runs" USING btree ("project_id") WHERE branch like 'brief/%' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');--> statement-breakpoint
CREATE POLICY "project_briefs_rw" ON "hive"."project_briefs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- Viết tay: projects là bảng của module catalog, schema.ts của knowledge không import được.
ALTER TABLE "hive"."project_briefs" ADD CONSTRAINT "project_briefs_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."project_briefs" FORCE ROW LEVEL SECURITY;
