CREATE TABLE "hive"."code_review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"side" text NOT NULL,
	"head_sha" text NOT NULL,
	"body" text NOT NULL,
	"author_id" text,
	"origin" text DEFAULT 'hive' NOT NULL,
	"external_author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "code_review_comments_side" CHECK ("hive"."code_review_comments"."side" in ('old', 'new')),
	CONSTRAINT "code_review_comments_origin" CHECK ("hive"."code_review_comments"."origin" in ('hive', 'github', 'gitlab')),
	CONSTRAINT "code_review_comments_line" CHECK ("hive"."code_review_comments"."line" > 0),
	CONSTRAINT "code_review_comments_body" CHECK (length("hive"."code_review_comments"."body") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "hive"."code_review_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "code_review_comments_org_review_id" ON "hive"."code_review_comments" USING btree ("org_id","review_id","id");--> statement-breakpoint
CREATE INDEX "code_review_comments_review" ON "hive"."code_review_comments" USING btree ("review_id","created_at","id");--> statement-breakpoint
CREATE INDEX "code_review_comments_thread" ON "hive"."code_review_comments" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_reviews_org_id" ON "hive"."code_reviews" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "hive"."code_review_comments" ADD CONSTRAINT "code_review_comments_org_id_review_id_code_reviews_org_id_id_fk" FOREIGN KEY ("org_id","review_id") REFERENCES "hive"."code_reviews"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."code_review_comments" ADD CONSTRAINT "code_review_comments_org_id_review_id_thread_id_code_review_comments_org_id_review_id_id_fk" FOREIGN KEY ("org_id","review_id","thread_id") REFERENCES "hive"."code_review_comments"("org_id","review_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "code_review_comments_rw" ON "hive"."code_review_comments" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- Ép RLS để kết nối bằng chủ bảng cũng không đọc nhầm dữ liệu tổ chức.
ALTER TABLE "hive"."code_review_comments" FORCE ROW LEVEL SECURITY;
