CREATE TYPE "hive"."client_event_outcome" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "hive"."client_source" AS ENUM('worker-run', 'worker', 'desktop', 'hive-cli', 'mcp-local', 'vscode', 'web', 'unknown');--> statement-breakpoint
CREATE TABLE "hive"."machine_token_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"score" double precision,
	"coverage" double precision NOT NULL,
	"score_version" integer NOT NULL,
	"report" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."machine_token_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."client_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" "hive"."client_source" NOT NULL,
	"machine_id" uuid,
	"user_id" text,
	"kind" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"client_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "hive"."client_event_outcome" NOT NULL,
	"reason_code" text,
	"reason" text,
	"response" jsonb,
	CONSTRAINT "client_events_org_key" UNIQUE("org_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "hive"."client_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machine_token_scores" ADD CONSTRAINT "machine_token_scores_machine_id_org_id_machines_id_org_id_fk" FOREIGN KEY ("machine_id","org_id") REFERENCES "hive"."machines"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_token_scores_machine" ON "hive"."machine_token_scores" USING btree ("machine_id","reported_at");--> statement-breakpoint
CREATE INDEX "machine_token_scores_team" ON "hive"."machine_token_scores" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "client_events_target" ON "hive"."client_events" USING btree ("org_id","target_type","target_id","received_at");--> statement-breakpoint
CREATE INDEX "client_events_received" ON "hive"."client_events" USING btree ("received_at");--> statement-breakpoint
CREATE POLICY "machine_token_scores_rw" ON "hive"."machine_token_scores" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "machine_token_scores_owner_select" ON "hive"."machine_token_scores" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_token_scores_owner_purge" ON "hive"."machine_token_scores" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "client_events_rw" ON "hive"."client_events" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "client_events_owner_select" ON "hive"."client_events" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "client_events_owner_purge" ON "hive"."client_events" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS; TRUNCATE không qua RLS nên thu lại.
ALTER TABLE hive.client_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.client_events TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.client_events FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.machine_token_scores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.machine_token_scores TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.machine_token_scores FROM hive_app;
--> statement-breakpoint
-- platform không import tenancy nên khoá ngoại tới orgs nằm ở đây: xoá tổ chức thì xoá luôn sự kiện client.
ALTER TABLE hive.client_events ADD CONSTRAINT client_events_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Job dọn hằng ngày không có tổ chức trong context nên cần SECURITY DEFINER; hai hàm chỉ xoá dòng quá hạn, không đọc
-- được gì. Sự kiện client giữ 30 ngày (≥ 14 ngày hộp thư đi, specs/027 FR-002); điểm token giữ 90 ngày (ADR 0036).
CREATE FUNCTION hive.purge_client_events() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.client_events WHERE received_at < now() - interval '30 days' RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_client_events() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_client_events() TO hive_app;
--> statement-breakpoint
CREATE FUNCTION hive.purge_machine_token_scores() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.machine_token_scores WHERE reported_at < now() - interval '90 days' RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_machine_token_scores() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_machine_token_scores() TO hive_app;
