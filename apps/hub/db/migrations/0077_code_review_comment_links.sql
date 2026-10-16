CREATE TABLE "hive"."code_review_comment_links" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"pr_number" integer NOT NULL,
	"provider_comment_id" text,
	"provider_thread_id" text,
	"provider_url" text,
	"mode" text DEFAULT 'inline' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"body_hash" text,
	"provider_updated_at" timestamp with time zone,
	"provider_resolved" boolean DEFAULT false NOT NULL,
	"provider_deleted" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"write_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_review_comment_links_state" CHECK ("hive"."code_review_comment_links"."state" in ('pending', 'synced', 'fallback', 'failed', 'disabled')),
	CONSTRAINT "code_review_comment_links_mode" CHECK ("hive"."code_review_comment_links"."mode" in ('inline', 'fallback')),
	CONSTRAINT "code_review_comment_links_provider" CHECK ("hive"."code_review_comment_links"."provider" in ('github', 'gitlab'))
);
--> statement-breakpoint
ALTER TABLE "hive"."code_review_comment_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_comments_org_id" ON "hive"."code_review_comments" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "hive"."code_review_comment_links" ADD CONSTRAINT "code_review_comment_links_org_id_comment_id_code_review_comments_org_id_id_fk" FOREIGN KEY ("org_id","comment_id") REFERENCES "hive"."code_review_comments"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_comment_links_provider_id" ON "hive"."code_review_comment_links" USING btree ("connection_id","provider_comment_id");--> statement-breakpoint
CREATE INDEX "code_review_comment_links_pending" ON "hive"."code_review_comment_links" USING btree ("org_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "code_review_comment_links_connection_write" ON "hive"."code_review_comment_links" USING btree ("connection_id","write_started_at");--> statement-breakpoint
CREATE POLICY "code_reviews_owner_select" ON "hive"."code_reviews" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "code_review_comment_links_rw" ON "hive"."code_review_comment_links" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE hive.code_review_comment_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Chỉ trả id tổ chức cho lịch nền; mọi dữ liệu review vẫn đọc bằng withTenant.
CREATE FUNCTION hive.code_review_comment_orgs() RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT r.org_id FROM hive.code_reviews r
  WHERE r.status IN ('in_review', 'changes_requested', 'approved')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.code_review_comment_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.code_review_comment_orgs() TO hive_app;
