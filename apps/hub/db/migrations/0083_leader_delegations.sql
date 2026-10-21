CREATE TYPE "hive"."leader_delegation_kind" AS ENUM('task', 'run');--> statement-breakpoint
CREATE TABLE "hive"."leader_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"kind" "hive"."leader_delegation_kind" NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."leader_delegations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."leader_delegations" ADD CONSTRAINT "leader_delegations_thread_id_org_id_chat_threads_id_org_id_fk" FOREIGN KEY ("thread_id","org_id") REFERENCES "hive"."chat_threads"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leader_delegations_thread" ON "hive"."leader_delegations" USING btree ("org_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "leader_delegations_task" ON "hive"."leader_delegations" USING btree ("org_id","task_id");--> statement-breakpoint
CREATE INDEX "leader_delegations_run" ON "hive"."leader_delegations" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE POLICY "leader_delegations_rw" ON "hive"."leader_delegations" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS; TRUNCATE không qua RLS nên thu lại.
ALTER TABLE hive.leader_delegations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.leader_delegations TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.leader_delegations FROM hive_app;
--> statement-breakpoint
-- Task và run nằm ở module khác; khoá ngoại viết tay để schema.ts không import chéo module. Khoá kép kiểm cả org_id vì
-- kiểm tham chiếu không chịu RLS. Xoá run chỉ xoá run_id: set null cả khoá ghép sẽ làm org_id null.
ALTER TABLE hive.leader_delegations ADD CONSTRAINT leader_delegations_task_id_org_fk FOREIGN KEY (task_id, org_id) REFERENCES hive.tasks(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.leader_delegations ADD CONSTRAINT leader_delegations_run_id_org_fk FOREIGN KEY (run_id, org_id) REFERENCES hive.runs(id, org_id) ON DELETE SET NULL (run_id);
