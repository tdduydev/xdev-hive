CREATE TABLE "hive"."agent_policies" (
	"org_id" uuid PRIMARY KEY DEFAULT hive.ctx_org() NOT NULL,
	"policy" jsonb NOT NULL,
	"template_sync" jsonb,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."agent_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."runs" ADD COLUMN "agent_policy_snapshot" jsonb;--> statement-breakpoint
CREATE POLICY "run_logs_owner_select" ON "hive"."run_logs" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "run_logs_owner_purge" ON "hive"."run_logs" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "agent_policies_rw" ON "hive"."agent_policies" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "agent_policies_owner_select" ON "hive"."agent_policies" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
ALTER TABLE "hive"."agent_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Xoá log run (run_logs) cũ hơn số ngày giữ log trong Chính sách agent của từng tổ chức; chưa có chính sách thì 365
-- ngày. Job chạy hằng ngày không có tổ chức trong context nên cần SECURITY DEFINER; hàm chỉ xoá log, không đọc được gì.
CREATE FUNCTION hive.purge_run_logs() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.run_logs l
    WHERE l.created_at < now() - make_interval(days => greatest(30, coalesce(
      (SELECT (p.policy -> 'limits' ->> 'runLogRetentionDays')::int FROM hive.agent_policies p WHERE p.org_id = l.org_id),
      365
    )))
    RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_run_logs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_run_logs() TO hive_app;
