CREATE TYPE "hive"."terminal_origin" AS ENUM('hub', 'local', 'remote');--> statement-breakpoint
CREATE TABLE "hive"."machine_remote_state" (
	"machine_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"roots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_locked_until" timestamp with time zone,
	"confirm_on_machine" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."machine_remote_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_org_endpoint" UNIQUE("org_id","endpoint")
);
--> statement-breakpoint
ALTER TABLE "hive"."push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."remote_devices" (
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"synced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "remote_devices_machine_id_id_pk" PRIMARY KEY("machine_id","id")
);
--> statement-breakpoint
ALTER TABLE "hive"."remote_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."terminal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"device_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."terminal_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."desktop_connect_codes" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ALTER COLUMN "mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."desktop_connect_codes" ADD COLUMN "purpose" text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD COLUMN "origin" "hive"."terminal_origin" DEFAULT 'hub' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD COLUMN "cwd_label" text;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD COLUMN "remote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."terminal_events" ADD CONSTRAINT "terminal_events_session_id_org_id_terminal_sessions_id_org_id_fk" FOREIGN KEY ("session_id","org_id") REFERENCES "hive"."terminal_sessions"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_remote_state_org" ON "hive"."machine_remote_state" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_org_user" ON "hive"."push_subscriptions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "remote_devices_org_user" ON "hive"."remote_devices" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "terminal_events_session" ON "hive"."terminal_events" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "terminal_events_org" ON "hive"."terminal_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_task" ON "hive"."terminal_sessions" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "hive"."desktop_connect_codes" ADD CONSTRAINT "desktop_connect_codes_purpose" CHECK ("hive"."desktop_connect_codes"."purpose" = 'cli' or ("hive"."desktop_connect_codes"."purpose" = 'desktop' and "hive"."desktop_connect_codes"."team_id" is not null));--> statement-breakpoint
ALTER TABLE "hive"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_hub_fields" CHECK ("hive"."terminal_sessions"."origin" <> 'hub' or ("hive"."terminal_sessions"."project_id" is not null and "hive"."terminal_sessions"."mode" is not null and "hive"."terminal_sessions"."model" is not null));--> statement-breakpoint
CREATE POLICY "terminal_chunks_owner_select" ON "hive"."terminal_chunks" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "terminal_chunks_owner_purge" ON "hive"."terminal_chunks" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_remote_state_rw" ON "hive"."machine_remote_state" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "push_subscriptions_rw" ON "hive"."push_subscriptions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "remote_devices_rw" ON "hive"."remote_devices" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "terminal_events_rw" ON "hive"."terminal_events" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."terminal_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."remote_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."push_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machine_remote_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Xoá bản ghi phiên terminal cũ hơn số ngày giữ log run của từng tổ chức (cùng job với purge_run_logs). Job không có tổ
-- chức trong context nên cần SECURITY DEFINER; hàm chỉ xoá, không đọc được gì.
CREATE FUNCTION hive.purge_terminal_chunks() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH gone AS (
    DELETE FROM hive.terminal_chunks c
    WHERE c.created_at < now() - make_interval(days => greatest(30, coalesce(
      (SELECT (p.policy -> 'limits' ->> 'runLogRetentionDays')::int FROM hive.agent_policies p WHERE p.org_id = c.org_id),
      365
    )))
    RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_terminal_chunks() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_terminal_chunks() TO hive_app;
