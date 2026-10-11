CREATE TYPE "hive"."machine_status" AS ENUM('online', 'offline', 'revoked');--> statement-breakpoint
CREATE TABLE "hive"."machine_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "hive"."machine_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"version" text NOT NULL,
	"clis" text[] DEFAULT '{}'::text[] NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"status" "hive"."machine_status" DEFAULT 'offline' NOT NULL,
	"public_key" text,
	"last_seen_at" timestamp with time zone,
	"registered_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "machines_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."machines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."registration_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_machine" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."machine_tokens" ADD CONSTRAINT "machine_tokens_machine_id_org_id_machines_id_org_id_fk" FOREIGN KEY ("machine_id","org_id") REFERENCES "hive"."machines"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."machines" ADD CONSTRAINT "machines_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."registration_tokens" ADD CONSTRAINT "registration_tokens_team_id_org_id_teams_id_org_id_fk" FOREIGN KEY ("team_id","org_id") REFERENCES "hive"."teams"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_tokens_machine" ON "hive"."machine_tokens" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_tokens_team" ON "hive"."machine_tokens" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "machines_team" ON "hive"."machines" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "registration_tokens_team" ON "hive"."registration_tokens" USING btree ("team_id");--> statement-breakpoint
CREATE POLICY "machine_tokens_select" ON "hive"."machine_tokens" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org() or token_hash = hive.ctx_fleet_token());--> statement-breakpoint
CREATE POLICY "machine_tokens_insert" ON "hive"."machine_tokens" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "machine_tokens_update" ON "hive"."machine_tokens" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "machine_tokens_delete" ON "hive"."machine_tokens" AS PERMISSIVE FOR DELETE TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "machines_rw" ON "hive"."machines" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "registration_tokens_select" ON "hive"."registration_tokens" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org() or token_hash = hive.ctx_fleet_token());--> statement-breakpoint
CREATE POLICY "registration_tokens_insert" ON "hive"."registration_tokens" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "registration_tokens_update" ON "hive"."registration_tokens" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "registration_tokens_delete" ON "hive"."registration_tokens" AS PERMISSIVE FOR DELETE TO "hive_app" USING (org_id = hive.ctx_org());