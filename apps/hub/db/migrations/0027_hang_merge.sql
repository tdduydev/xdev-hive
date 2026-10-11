CREATE TYPE "hive"."merge_queue_state" AS ENUM('queued', 'updating', 'waiting', 'merging', 'merged', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "hive"."merge_queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text,
	"branch" text,
	"head_sha" text,
	"run_id" uuid,
	"task_id" uuid,
	"state" "hive"."merge_queue_state" DEFAULT 'queued' NOT NULL,
	"note" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"waiting_since" timestamp with time zone,
	"merge_sha" text,
	"enqueued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hive"."merge_queue_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."merge_queue_entries" ADD CONSTRAINT "merge_queue_entries_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_entries_active_pr" ON "hive"."merge_queue_entries" USING btree ("project_id","pr_number") WHERE state in ('queued', 'updating', 'waiting', 'merging');--> statement-breakpoint
CREATE INDEX "merge_queue_entries_project_created" ON "hive"."merge_queue_entries" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "merge_queue_entries_org" ON "hive"."merge_queue_entries" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "merge_queue_entries_rw" ON "hive"."merge_queue_entries" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());