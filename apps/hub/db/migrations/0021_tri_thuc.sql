CREATE TYPE "hive"."memory_kind" AS ENUM('decision', 'convention', 'gotcha', 'note');--> statement-breakpoint
CREATE TYPE "hive"."proposal_kind" AS ENUM('doc', 'skill');--> statement-breakpoint
CREATE TYPE "hive"."proposal_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "hive"."doc_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"message" text,
	"proposal_id" uuid,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_versions_doc_version" UNIQUE("doc_id","version"),
	CONSTRAINT "doc_versions_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"current_version" integer NOT NULL,
	"updated_by_user_id" text,
	"updated_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_org_key" UNIQUE("org_id","key"),
	CONSTRAINT "docs_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "docs_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "docs_updated_by" CHECK ((updated_by_user_id is null) <> (updated_by_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"kind" "hive"."memory_kind" NOT NULL,
	"content" text NOT NULL,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_user_id" text,
	"author_run_id" uuid,
	"embedding_model" text,
	"superseded_by" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_content_len" CHECK (char_length(content) between 1 and 2000),
	CONSTRAINT "memories_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "memories_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"kind" "hive"."proposal_kind" NOT NULL,
	"target" text NOT NULL,
	"base_version" integer NOT NULL,
	"title" text,
	"description" text,
	"content" text NOT NULL,
	"reason" text,
	"status" "hive"."proposal_status" DEFAULT 'pending' NOT NULL,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"result_version" integer,
	CONSTRAINT "proposals_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "proposals_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"message" text,
	"proposal_id" uuid,
	"author_user_id" text,
	"author_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_version" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_versions_author" CHECK ((author_user_id is null) <> (author_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."skill_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"current_version" integer NOT NULL,
	"updated_by_user_id" text,
	"updated_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_scope_name" UNIQUE NULLS NOT DISTINCT("org_id","team_id","project_id","name"),
	CONSTRAINT "skills_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "skills_scope" CHECK (project_id is null or team_id is not null),
	CONSTRAINT "skills_updated_by" CHECK ((updated_by_user_id is null) <> (updated_by_run_id is null))
);
--> statement-breakpoint
ALTER TABLE "hive"."skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD CONSTRAINT "doc_versions_doc_id_org_id_docs_id_org_id_fk" FOREIGN KEY ("doc_id","org_id") REFERENCES "hive"."docs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "hive"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."skill_versions" ADD CONSTRAINT "skill_versions_skill_id_org_id_skills_id_org_id_fk" FOREIGN KEY ("skill_id","org_id") REFERENCES "hive"."skills"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_versions_org" ON "hive"."doc_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "docs_scope" ON "hive"."docs" USING btree ("org_id","team_id","project_id");--> statement-breakpoint
CREATE INDEX "memories_scope" ON "hive"."memories" USING btree ("org_id","team_id","project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memories_search" ON "hive"."memories" USING gin ("search");--> statement-breakpoint
CREATE INDEX "proposals_org_status" ON "hive"."proposals" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skill_versions_org" ON "hive"."skill_versions" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "doc_versions_rw" ON "hive"."doc_versions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "docs_rw" ON "hive"."docs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "memories_rw" ON "hive"."memories" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "proposals_rw" ON "hive"."proposals" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "skill_versions_rw" ON "hive"."skill_versions" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "skills_rw" ON "hive"."skills" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());