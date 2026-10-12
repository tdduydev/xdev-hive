CREATE TABLE "hive"."desktop_connect_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"machine" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_connect_codes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "hive"."desktop_connect_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."desktop_connect_codes" ADD CONSTRAINT "desktop_connect_codes_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "desktop_connect_codes_select" ON "hive"."desktop_connect_codes" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org() or token_hash = hive.ctx_fleet_token());--> statement-breakpoint
CREATE POLICY "desktop_connect_codes_insert" ON "hive"."desktop_connect_codes" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "desktop_connect_codes_update" ON "hive"."desktop_connect_codes" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "desktop_connect_codes_delete" ON "hive"."desktop_connect_codes" AS PERMISSIVE FOR DELETE TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."desktop_connect_codes" FORCE ROW LEVEL SECURITY;
