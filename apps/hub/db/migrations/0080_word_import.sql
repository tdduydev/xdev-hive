CREATE TABLE "hive"."doc_word_import_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"relative_dir" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"blob_id" uuid,
	"last_modified" timestamp with time zone,
	"version_label" text,
	"proposed_path" text,
	"proposed_title" text,
	"path_override" text,
	"title_override" text,
	"keep_front" boolean DEFAULT false NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"markdown" text,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stats" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"link_matches" boolean,
	"doc_id" uuid,
	"doc_version" integer,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_word_import_files_import_name" UNIQUE("import_id","relative_dir","file_name"),
	CONSTRAINT "doc_word_import_files_format" CHECK (format in ('docx', 'odt', 'doc')),
	CONSTRAINT "doc_word_import_files_state" CHECK (state in ('queued', 'converting', 'ready', 'skipped', 'blocked_secret', 'failed', 'proposed', 'cancelled', 'done')),
	CONSTRAINT "doc_word_import_files_size" CHECK (size >= 0),
	CONSTRAINT "doc_word_import_files_doc_version" CHECK (doc_version is null or doc_version >= 1)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_word_import_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_word_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"target_dir" text,
	"mode" text DEFAULT 'create' NOT NULL,
	"update_doc_id" uuid,
	"confidential" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"counts" jsonb DEFAULT '{"queued":0,"converting":0,"ready":0,"skipped":0,"blockedSecret":0,"failed":0,"proposed":0,"cancelled":0,"done":0}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_word_imports_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "doc_word_imports_mode" CHECK (mode in ('create', 'update', 'link')),
	CONSTRAINT "doc_word_imports_target" CHECK ((mode = 'create' and target_dir is not null and update_doc_id is null) or (mode <> 'create' and update_doc_id is not null)),
	CONSTRAINT "doc_word_imports_state" CHECK (state in ('uploading', 'converting', 'ready', 'committing', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_word_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."doc_assets" DROP CONSTRAINT "doc_assets_state";--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" DROP CONSTRAINT "doc_versions_source";--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ALTER COLUMN "repo_commit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ADD COLUMN "origin" text DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ADD COLUMN "base_content" text;--> statement-breakpoint
ALTER TABLE "hive"."doc_homes" ADD COLUMN "word_import_confidential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."proposals" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "hive"."doc_word_import_files" ADD CONSTRAINT "doc_word_import_files_import_id_org_id_doc_word_imports_id_org_id_fk" FOREIGN KEY ("import_id","org_id") REFERENCES "hive"."doc_word_imports"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_word_imports" ADD CONSTRAINT "doc_word_imports_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_word_import_files_resume" ON "hive"."doc_word_import_files" USING btree ("org_id","import_id","state");--> statement-breakpoint
CREATE INDEX "doc_word_import_files_doc" ON "hive"."doc_word_import_files" USING btree ("org_id","doc_id");--> statement-breakpoint
CREATE INDEX "doc_word_import_files_blob" ON "hive"."doc_word_import_files" USING btree ("org_id","blob_id");--> statement-breakpoint
CREATE INDEX "doc_word_imports_home" ON "hive"."doc_word_imports" USING btree ("org_id","home_id","created_at");--> statement-breakpoint
ALTER TABLE "hive"."doc_assets" ADD CONSTRAINT "doc_assets_state" CHECK (state in ('available', 'missing_lfs', 'too_large', 'pending_push', 'pending_delete'));--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ADD CONSTRAINT "doc_conflicts_origin" CHECK ((origin = 'repo' and repo_commit is not null) or (origin = 'word' and base_content is not null));--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD CONSTRAINT "doc_versions_source" CHECK (source in ('hub', 'repo', 'import', 'merge', 'word'));--> statement-breakpoint
CREATE POLICY "doc_word_import_files_rw" ON "hive"."doc_word_import_files" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_word_imports_rw" ON "hive"."doc_word_imports" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- Khóa ngoại cũng kiểm org_id vì kiểm tham chiếu không chịu RLS. Migration chỉ thêm giá trị vào check (không dùng
-- enum), nên nâng cấp database đã có dữ liệu không vướng giá trị enum chưa commit.
ALTER TABLE hive.doc_word_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_word_imports TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_word_imports FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_word_imports ADD CONSTRAINT doc_word_imports_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_word_imports ADD CONSTRAINT doc_word_imports_update_doc_id_org_fk FOREIGN KEY (update_doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE hive.doc_word_import_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_word_import_files TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_word_import_files FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_word_import_files ADD CONSTRAINT doc_word_import_files_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_word_import_files ADD CONSTRAINT doc_word_import_files_doc_id_org_fk FOREIGN KEY (doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
-- File gốc giữ blob như đính kèm; ảnh giữ tạm nằm trong jsonb nên GC dựa vào nguồn tham chiếu "docsync-word".
ALTER TABLE hive.doc_word_import_files ADD CONSTRAINT doc_word_import_files_blob_id_org_fk FOREIGN KEY (blob_id, org_id) REFERENCES hive.blobs(id, org_id) ON DELETE NO ACTION;
