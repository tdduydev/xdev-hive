CREATE TYPE "hive"."plan_status" AS ENUM('awaiting', 'approved', 'rejected', 'superseded');--> statement-breakpoint
ALTER TYPE "hive"."run_kind" ADD VALUE 'plan';--> statement-breakpoint
ALTER TYPE "hive"."task_status" ADD VALUE 'awaiting_plan' BEFORE 'review';--> statement-breakpoint
CREATE TABLE "hive"."plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"plan_run_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" "hive"."plan_status" DEFAULT 'awaiting' NOT NULL,
	"content" jsonb NOT NULL,
	"edited_content" jsonb,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_plan_run" UNIQUE("plan_run_id"),
	CONSTRAINT "plans_task_revision" UNIQUE("task_id","revision")
);
--> statement-breakpoint
ALTER TABLE "hive"."plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."plans" ADD CONSTRAINT "plans_task_id_org_id_tasks_id_org_id_fk" FOREIGN KEY ("task_id","org_id") REFERENCES "hive"."tasks"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_run_awaiting" ON "hive"."plans" USING btree ("run_id") WHERE status = 'awaiting';--> statement-breakpoint
CREATE INDEX "plans_org_team" ON "hive"."plans" USING btree ("org_id","team_id");--> statement-breakpoint
CREATE INDEX "plans_task_created" ON "hive"."plans" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "plans_run" ON "hive"."plans" USING btree ("run_id");--> statement-breakpoint
CREATE POLICY "plans_rw" ON "hive"."plans" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());