CREATE TABLE "hive"."inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"event_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp (3) with time zone,
	CONSTRAINT "inbox_items_recipient_event" UNIQUE("org_id","user_id","event","event_key")
);
--> statement-breakpoint
ALTER TABLE "hive"."inbox_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "inbox_items_recipient_created" ON "hive"."inbox_items" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "inbox_items_recipient_unread" ON "hive"."inbox_items" USING btree ("org_id","user_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "inbox_items_read_at" ON "hive"."inbox_items" USING btree ("read_at") WHERE read_at is not null;--> statement-breakpoint
CREATE POLICY "inbox_items_rw" ON "hive"."inbox_items" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org() and user_id = hive.ctx_user()) WITH CHECK (org_id = hive.ctx_org() and user_id = hive.ctx_user());--> statement-breakpoint
CREATE POLICY "inbox_items_insert" ON "hive"."inbox_items" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
ALTER TABLE hive.inbox_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.inbox_items FROM hive_app;
--> statement-breakpoint
-- Người nhận phải thuộc đúng tổ chức, kể cả khi nghiệp vụ chạy trong job không có người thao tác.
ALTER TABLE hive.inbox_items ADD CONSTRAINT inbox_items_member_fk
  FOREIGN KEY (org_id, user_id) REFERENCES hive.org_members (org_id, user_id) ON DELETE CASCADE;
