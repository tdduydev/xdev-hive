CREATE TYPE "hive"."machine_kind" AS ENUM('worker', 'host');--> statement-breakpoint
CREATE TABLE "hive"."egress_allowlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"rule" text NOT NULL,
	"note" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_allowlists_scope" CHECK (("hive"."egress_allowlists"."project_id" is null) = ("hive"."egress_allowlists"."team_id" is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."egress_allowlists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."env_images" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"base_image" text NOT NULL,
	"setup_script_hash" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."env_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."sandbox_org_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"use_suggested_defaults" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."sandbox_org_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD COLUMN "kind" "hive"."machine_kind" DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ADD COLUMN "kind" "hive"."machine_kind" DEFAULT 'worker' NOT NULL;--> statement-breakpoint
CREATE INDEX "egress_allowlists_org_project" ON "hive"."egress_allowlists" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "egress_allowlists_team" ON "hive"."egress_allowlists" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "env_images_org" ON "hive"."env_images" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "env_images_team" ON "hive"."env_images" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "hive"."projects" ADD CONSTRAINT "projects_id_org_team" UNIQUE("id","org_id","team_id");--> statement-breakpoint
CREATE POLICY "egress_allowlists_rw" ON "hive"."egress_allowlists" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "env_images_rw" ON "hive"."env_images" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "sandbox_org_settings_rw" ON "hive"."sandbox_org_settings" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE hive.egress_allowlists FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.env_images FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.sandbox_org_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.sandbox_org_settings ADD CONSTRAINT sandbox_org_settings_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.egress_allowlists ADD CONSTRAINT egress_allowlists_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.egress_allowlists ADD CONSTRAINT egress_allowlists_project_fk FOREIGN KEY (project_id, org_id, team_id) REFERENCES hive.projects(id, org_id, team_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.env_images ADD CONSTRAINT env_images_project_fk FOREIGN KEY (project_id, org_id, team_id) REFERENCES hive.projects(id, org_id, team_id) ON DELETE CASCADE;
