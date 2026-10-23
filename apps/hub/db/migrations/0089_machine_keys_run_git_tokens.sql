-- Máy đổi khoá máy lấy access token (specs/027 US3): truy vấn tìm máy theo id trước khi biết tổ chức, như ctx_fleet_token.
CREATE FUNCTION hive.ctx_fleet_machine() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.fleet_machine_id', true), '')
$$;
--> statement-breakpoint
CREATE TABLE "hive"."run_git_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" "hive"."scm_kind" NOT NULL,
	"external_id" text,
	"repo" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."run_git_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machine_tokens" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "public_key_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "key_storage" text;--> statement-breakpoint
CREATE INDEX "run_git_tokens_run" ON "hive"."run_git_tokens" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "run_git_tokens_open" ON "hive"."run_git_tokens" USING btree ("created_at") WHERE revoked_at is null and external_id is not null;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD CONSTRAINT "machines_key_storage" CHECK ("hive"."machines"."key_storage" in ('keychain', 'file'));--> statement-breakpoint
CREATE POLICY "machines_by_id" ON "hive"."machines" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id::text = hive.ctx_fleet_machine());--> statement-breakpoint
CREATE POLICY "run_git_tokens_rw" ON "hive"."run_git_tokens" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "run_git_tokens_owner_select" ON "hive"."run_git_tokens" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);
--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.run_git_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.run_git_tokens FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.run_git_tokens ADD CONSTRAINT run_git_tokens_org_fk
  FOREIGN KEY (org_id) REFERENCES hive.orgs (id) ON DELETE CASCADE;
--> statement-breakpoint
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì dòng trỏ được tới kết nối của tổ chức khác.
ALTER TABLE hive.run_git_tokens ADD CONSTRAINT run_git_tokens_connection_fk
  FOREIGN KEY (connection_id, org_id) REFERENCES hive.scm_connections (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
-- Job quét thu hồi token GitLab chạy cho mọi tổ chức: chỉ lộ id tổ chức còn token mở, không nới RLS cho hive_app.
CREATE FUNCTION hive.run_git_token_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT t.org_id FROM hive.run_git_tokens AS t WHERE t.revoked_at IS NULL AND t.external_id IS NOT NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.run_git_token_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.run_git_token_orgs() TO hive_app;
