ALTER TABLE "hive"."runs" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "leader_thread_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_leader_thread_active" ON "hive"."runs" USING btree ("leader_thread_id") WHERE kind = 'leader' and state not in ('succeeded', 'no_changes', 'needs_review', 'failed', 'cancelled');