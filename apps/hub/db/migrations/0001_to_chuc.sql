CREATE SCHEMA IF NOT EXISTS "hive";
--> statement-breakpoint
CREATE TYPE "hive"."member_status" AS ENUM('active', 'pending', 'blocked');--> statement-breakpoint
CREATE TYPE "hive"."org_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "hive"."team_role" AS ENUM('admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "hive"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"org_role" "hive"."org_role" DEFAULT 'member' NOT NULL,
	"team_id" uuid,
	"team_role" "hive"."team_role",
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "hive"."invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."org_members" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "hive"."org_role" DEFAULT 'member' NOT NULL,
	"status" "hive"."member_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."org_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."orgs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"email_domain" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "hive"."orgs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "systems_team_slug" UNIQUE("team_id","slug")
);
--> statement-breakpoint
ALTER TABLE "hive"."systems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."team_members" (
	"team_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "hive"."team_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_org_slug" UNIQUE("org_id","slug"),
	CONSTRAINT "teams_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."invitations" ADD CONSTRAINT "invitations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hive"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hive"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."systems" ADD CONSTRAINT "systems_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."team_members" ADD CONSTRAINT "team_members_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."teams" ADD CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "hive"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "invitations_select" ON "hive"."invitations" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org() or token_hash = hive.ctx_invite());--> statement-breakpoint
CREATE POLICY "invitations_insert" ON "hive"."invitations" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "invitations_update" ON "hive"."invitations" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "invitations_delete" ON "hive"."invitations" AS PERMISSIVE FOR DELETE TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "org_members_select" ON "hive"."org_members" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org() or user_id = hive.ctx_user());--> statement-breakpoint
CREATE POLICY "org_members_write" ON "hive"."org_members" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "org_members_update" ON "hive"."org_members" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "org_members_delete" ON "hive"."org_members" AS PERMISSIVE FOR DELETE TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "orgs_select" ON "hive"."orgs" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id = hive.ctx_org() or exists (select 1 from hive.org_members m where m.org_id = orgs.id and m.user_id = hive.ctx_user() and m.status = 'active'));--> statement-breakpoint
CREATE POLICY "orgs_insert" ON "hive"."orgs" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "orgs_update" ON "hive"."orgs" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (id = hive.ctx_org()) WITH CHECK (id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "systems_rw" ON "hive"."systems" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "team_members_rw" ON "hive"."team_members" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "teams_rw" ON "hive"."teams" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());