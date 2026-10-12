CREATE TYPE "hive"."role_scope" AS ENUM('org', 'team');--> statement-breakpoint
CREATE TABLE "hive"."custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" "hive"."role_scope" NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_roles_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "custom_roles_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."custom_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."member_custom_roles" (
	"role_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_custom_roles_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."member_custom_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."team_custom_roles" (
	"role_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_custom_roles_role_id_team_id_pk" PRIMARY KEY("role_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."team_custom_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."custom_roles" ADD CONSTRAINT "custom_roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hive"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."member_custom_roles" ADD CONSTRAINT "member_custom_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."member_custom_roles" ADD CONSTRAINT "member_custom_roles_role_id_org_id_custom_roles_id_org_id_fk" FOREIGN KEY ("role_id","org_id") REFERENCES "hive"."custom_roles"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."team_custom_roles" ADD CONSTRAINT "team_custom_roles_role_id_org_id_custom_roles_id_org_id_fk" FOREIGN KEY ("role_id","org_id") REFERENCES "hive"."custom_roles"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."team_custom_roles" ADD CONSTRAINT "team_custom_roles_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "custom_roles_rw" ON "hive"."custom_roles" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "member_custom_roles_rw" ON "hive"."member_custom_roles" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "team_custom_roles_rw" ON "hive"."team_custom_roles" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE "hive"."custom_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."member_custom_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."team_custom_roles" FORCE ROW LEVEL SECURITY;
