-- Telegram/Slack gọi /hooks/chat/{kind}/{botId} không có phiên người dùng nên chưa biết tổ chức. Module chat đặt id bot
-- vào app.chat_bot_id trong transaction; policy SELECT của chat_bots cho thấy đúng dòng có id đó (cùng cách
-- ctx_webhook_project của catalog). Không dùng SECURITY DEFINER vì bảng bị FORCE RLS.
CREATE FUNCTION hive.ctx_chat_bot() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.chat_bot_id', true), '')::uuid
$$;--> statement-breakpoint
CREATE TYPE "hive"."chat_bot_kind" AS ENUM('telegram', 'slack');--> statement-breakpoint
CREATE TYPE "hive"."chat_outbox_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "hive"."chat_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "hive"."chat_bot_kind" NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_enc" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_bots_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "chat_bots_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_bots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_link_codes_bot_hash" UNIQUE("bot_id","code_hash")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"events" text[] NOT NULL,
	"project_id" uuid,
	"thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_links_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "chat_links_bot_external" UNIQUE("bot_id","external_user_id"),
	CONSTRAINT "chat_links_bot_user" UNIQUE("bot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_org_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"allow_groups" boolean DEFAULT false NOT NULL,
	"user_daily_limit" integer DEFAULT 30 NOT NULL,
	"org_daily_limit" integer DEFAULT 300 NOT NULL,
	"leader_model" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_org_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event" text,
	"dedupe_key" text,
	"title" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"url" text,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "hive"."chat_outbox_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "chat_outbox_link_dedupe" UNIQUE("link_id","dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."chat_usage" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_usage_org_id_user_id_day_pk" PRIMARY KEY("org_id","user_id","day")
);
--> statement-breakpoint
ALTER TABLE "hive"."chat_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_link_codes" ADD CONSTRAINT "chat_link_codes_bot_id_org_id_chat_bots_id_org_id_fk" FOREIGN KEY ("bot_id","org_id") REFERENCES "hive"."chat_bots"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."chat_links" ADD CONSTRAINT "chat_links_bot_id_org_id_chat_bots_id_org_id_fk" FOREIGN KEY ("bot_id","org_id") REFERENCES "hive"."chat_bots"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."chat_outbox" ADD CONSTRAINT "chat_outbox_link_id_org_id_chat_links_id_org_id_fk" FOREIGN KEY ("link_id","org_id") REFERENCES "hive"."chat_links"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_bots_org" ON "hive"."chat_bots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "chat_link_codes_user" ON "hive"."chat_link_codes" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_links_org_user" ON "hive"."chat_links" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_links_thread" ON "hive"."chat_links" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_outbox_link" ON "hive"."chat_outbox" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "chat_outbox_org_created" ON "hive"."chat_outbox" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE POLICY "chat_bots_rw" ON "hive"."chat_bots" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_bots_webhook_lookup" ON "hive"."chat_bots" AS PERMISSIVE FOR SELECT TO "hive_app" USING (id = hive.ctx_chat_bot());--> statement-breakpoint
CREATE POLICY "chat_link_codes_rw" ON "hive"."chat_link_codes" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_links_rw" ON "hive"."chat_links" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_org_settings_rw" ON "hive"."chat_org_settings" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_outbox_rw" ON "hive"."chat_outbox" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "chat_usage_rw" ON "hive"."chat_usage" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
ALTER TABLE "hive"."chat_bots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_org_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_link_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_usage" FORCE ROW LEVEL SECURITY;
