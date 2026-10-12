ALTER TYPE "hive"."run_kind" ADD VALUE 'docassist';--> statement-breakpoint
CREATE TABLE "hive"."doc_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_comments_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"base_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"updated_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_drafts_org_key" UNIQUE("org_id","key"),
	CONSTRAINT "doc_drafts_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "doc_drafts_updated_by" CHECK ((updated_by_user_id is null) <> (updated_by_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_presence" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "doc_presence_org_id_key_user_id_pk" PRIMARY KEY("org_id","key","user_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_presence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"key" text NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"base_version" integer NOT NULL,
	"proposal_id" uuid,
	"note" text,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_snapshots_number" UNIQUE("org_id","key","number"),
	CONSTRAINT "doc_snapshots_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "doc_snapshots_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"key" text NOT NULL,
	"before" text NOT NULL,
	"after" text NOT NULL,
	"reason" text,
	"author_user_id" text,
	"author_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_suggestions_status" CHECK (status in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "doc_suggestions_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "doc_suggestions_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"key" text NOT NULL,
	"quote" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"resolved_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_threads_scope" CHECK (project_id is null or team_id is not null)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."doc_comments" ADD CONSTRAINT "doc_comments_thread_id_doc_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "hive"."doc_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_snapshots" ADD CONSTRAINT "doc_snapshots_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "hive"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_comments_thread" ON "hive"."doc_comments" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "doc_suggestions_doc" ON "hive"."doc_suggestions" USING btree ("org_id","key","status","created_at");--> statement-breakpoint
CREATE INDEX "doc_threads_doc" ON "hive"."doc_threads" USING btree ("org_id","key","created_at");--> statement-breakpoint
CREATE POLICY "doc_comments_rw" ON "hive"."doc_comments" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_drafts_rw" ON "hive"."doc_drafts" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_presence_rw" ON "hive"."doc_presence" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_snapshots_rw" ON "hive"."doc_snapshots" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_suggestions_rw" ON "hive"."doc_suggestions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_threads_rw" ON "hive"."doc_threads" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."doc_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."doc_suggestions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."doc_threads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."doc_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."doc_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hive"."doc_presence" FORCE ROW LEVEL SECURITY;
