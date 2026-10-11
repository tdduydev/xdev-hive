DROP INDEX "hive"."runs_task_active";--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD CONSTRAINT "runs_parent_run_id_org_id_runs_id_org_id_fk" FOREIGN KEY ("parent_run_id","org_id") REFERENCES "hive"."runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_review_active" ON "hive"."runs" USING btree ("parent_run_id") WHERE state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_task_active" ON "hive"."runs" USING btree ("task_id") WHERE kind = 'code' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');