CREATE TYPE "hive"."webhook_delivery_status" AS ENUM('queued', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "hive"."webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "hive"."scm_kind" NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "hive"."webhook_delivery_status" NOT NULL,
	"error" text,
	CONSTRAINT "webhook_deliveries_provider_delivery" UNIQUE("provider","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_project" ON "hive"."webhook_deliveries" USING btree ("org_id","project_id","received_at");--> statement-breakpoint
CREATE POLICY "projects_webhook_lookup" ON "hive"."projects" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id = hive.ctx_webhook_project());--> statement-breakpoint
CREATE POLICY "webhook_deliveries_rw" ON "hive"."webhook_deliveries" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());