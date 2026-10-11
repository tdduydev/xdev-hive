CREATE TYPE "hive"."notification_channel_kind" AS ENUM('telegram', 'email');--> statement-breakpoint
CREATE TYPE "hive"."notification_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "hive"."notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "hive"."notification_channel_kind" NOT NULL,
	"name" text NOT NULL,
	"events" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"target" text NOT NULL,
	"config_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "notification_channels_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."notification_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"status" "hive"."notification_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hive"."notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "notification_channels_org" ON "hive"."notification_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notifications_org_created" ON "hive"."notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_channel" ON "hive"."notifications" USING btree ("channel_id");--> statement-breakpoint
CREATE POLICY "notification_channels_rw" ON "hive"."notification_channels" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "notifications_rw" ON "hive"."notifications" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());