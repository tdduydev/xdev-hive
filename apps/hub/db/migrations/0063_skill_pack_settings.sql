CREATE TABLE "hive"."skill_pack_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_pack_settings_scope_name" UNIQUE NULLS NOT DISTINCT("org_id","project_id","name")
);
--> statement-breakpoint
ALTER TABLE "hive"."skill_pack_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_pack_settings_rw" ON "hive"."skill_pack_settings" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- Viết tay: projects là bảng của module catalog, schema.ts của knowledge không import được. Xoá dự án thì xoá đặt riêng.
ALTER TABLE "hive"."skill_pack_settings" ADD CONSTRAINT "skill_pack_settings_project_id_org_id_projects_id_org_id_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "hive"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."skill_pack_settings" FORCE ROW LEVEL SECURITY;
