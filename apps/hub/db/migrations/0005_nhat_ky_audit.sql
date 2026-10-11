CREATE TABLE "hive"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_log_org_created" ON "hive"."audit_log" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_org_target" ON "hive"."audit_log" USING btree ("org_id","target_type","target_id");--> statement-breakpoint
CREATE POLICY "audit_log_select" ON "hive"."audit_log" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "audit_log_insert" ON "hive"."audit_log" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());