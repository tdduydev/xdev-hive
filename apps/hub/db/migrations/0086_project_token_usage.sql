CREATE TABLE "hive"."project_token_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"tokens" jsonb NOT NULL,
	"sessions" integer NOT NULL,
	"score" integer,
	"policy_drift" text[] NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_token_usage_period" UNIQUE("machine_id","project_id","period_end")
);
--> statement-breakpoint
ALTER TABLE "hive"."project_token_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."project_token_usage" ADD CONSTRAINT "project_token_usage_machine_id_org_id_machines_id_org_id_fk" FOREIGN KEY ("machine_id","org_id") REFERENCES "hive"."machines"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_token_usage_project" ON "hive"."project_token_usage" USING btree ("org_id","project_id","period_end" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "project_token_usage_rw" ON "hive"."project_token_usage" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "project_token_usage_owner_select" ON "hive"."project_token_usage" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "project_token_usage_owner_purge" ON "hive"."project_token_usage" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS; TRUNCATE không qua RLS nên thu lại.
ALTER TABLE hive.project_token_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.project_token_usage TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.project_token_usage FROM hive_app;
--> statement-breakpoint
-- fleet không import schema của catalog nên khoá ngoại tới projects viết tay: xoá dự án thì xoá luôn số token của nó.
ALTER TABLE hive.project_token_usage ADD CONSTRAINT project_token_usage_project_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
-- Job dọn hằng ngày (cùng job với điểm máy) không có tổ chức trong context nên cần SECURITY DEFINER; hàm chỉ xoá dòng
-- quá 90 ngày, không đọc được gì.
CREATE FUNCTION hive.purge_project_token_usage() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.project_token_usage WHERE received_at < now() - interval '90 days' RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_project_token_usage() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_project_token_usage() TO hive_app;
