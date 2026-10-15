CREATE TABLE "hive"."doc_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"repo_path" text NOT NULL,
	"blob_id" uuid,
	"media_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"lfs" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'available' NOT NULL,
	"owner_doc_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_assets_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "doc_assets_home_path" UNIQUE("home_id","repo_path"),
	CONSTRAINT "doc_assets_state" CHECK (state in ('available', 'missing_lfs', 'too_large', 'pending_push')),
	CONSTRAINT "doc_assets_size" CHECK (size >= 0),
	CONSTRAINT "doc_assets_blob" CHECK (state not in ('available', 'pending_push') or blob_id is not null)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"hub_version" integer NOT NULL,
	"repo_commit" text NOT NULL,
	"repo_content" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_conflicts_state" CHECK (state in ('open', 'resolved')),
	CONSTRAINT "doc_conflicts_resolution" CHECK (resolution is null or resolution in ('hub', 'repo', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_extracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source_sha256" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"secret_flag" boolean DEFAULT false NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_extracts_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "doc_extracts_state" CHECK (state in ('pending', 'review', 'approved', 'rejected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_extracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_homes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid,
	"connection_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"root" text DEFAULT 'docs/' NOT NULL,
	"assets_dir" text DEFAULT 'assets' NOT NULL,
	"mode" text DEFAULT 'pr' NOT NULL,
	"include" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"repo_changes_need_review" boolean DEFAULT false NOT NULL,
	"last_commit" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"error" text,
	"webhook_secret_enc" text,
	"webhook_id" text,
	"pr_number" integer,
	"pr_url" text,
	"lfs_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"configured_by" text NOT NULL,
	"first_queued_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_homes_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "doc_homes_scope" CHECK ((scope = 'project' and project_id is not null) or (scope = 'org' and project_id is null)),
	CONSTRAINT "doc_homes_mode" CHECK (mode in ('pr', 'direct', 'off')),
	CONSTRAINT "doc_homes_status" CHECK (status in ('active', 'paused', 'error'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_homes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_import_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"repo_path" text NOT NULL,
	"blob_sha" text,
	"key" text,
	"existing_key" text,
	"secret_scan" text DEFAULT 'pending' NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"kind" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"doc_id" uuid,
	"asset_id" uuid,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_import_files_import_path" UNIQUE("import_id","repo_path"),
	CONSTRAINT "doc_import_files_secret_scan" CHECK (secret_scan in ('pending', 'clean', 'found')),
	CONSTRAINT "doc_import_files_kind" CHECK (kind in ('markdown', 'image', 'office', 'other')),
	CONSTRAINT "doc_import_files_state" CHECK (state in ('pending', 'done', 'skipped', 'blocked_secret', 'failed')),
	CONSTRAINT "doc_import_files_size" CHECK (size >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_import_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"commit_sha" text,
	"include" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'scanning' NOT NULL,
	"progress" jsonb DEFAULT '{"done":0,"total":0,"cursor":null}'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_imports_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "doc_imports_state" CHECK (state in ('scanning', 'ready', 'importing', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_repo_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"repo_path" text NOT NULL,
	"synced_version" integer,
	"synced_commit" text,
	"synced_hash" text,
	"repo_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"eol" text DEFAULT 'lf' NOT NULL,
	"bom" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_repo_files_home_path" UNIQUE("home_id","repo_path"),
	CONSTRAINT "doc_repo_files_doc" UNIQUE("doc_id"),
	CONSTRAINT "doc_repo_files_state" CHECK (state in ('synced', 'pending', 'conflict', 'failed', 'deleted_in_repo', 'blocked_secret', 'excluded')),
	CONSTRAINT "doc_repo_files_eol" CHECK (eol in ('lf', 'crlf'))
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_repo_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_sync_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"branch" text NOT NULL,
	"doc_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"commit_sha" text,
	"pr_number" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_sync_batches_mode" CHECK (mode in ('pr', 'direct')),
	CONSTRAINT "doc_sync_batches_state" CHECK (state in ('queued', 'pushing', 'done', 'failed')),
	CONSTRAINT "doc_sync_batches_attempts" CHECK (attempts >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_sync_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."doc_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"doc_id" uuid,
	"extract_id" uuid,
	"version" integer NOT NULL,
	"ord" integer NOT NULL,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"content" text NOT NULL,
	"embedding_model" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_chunks_doc_version_ord" UNIQUE("doc_id","version","ord"),
	CONSTRAINT "doc_chunks_extract_version_ord" UNIQUE("extract_id","version","ord"),
	CONSTRAINT "doc_chunks_parent" CHECK ((doc_id is null) <> (extract_id is null)),
	CONSTRAINT "doc_chunks_position" CHECK (version > 0 and ord >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."doc_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."blob_chunks" (
	"blob_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "blob_chunks_blob_id_ord_pk" PRIMARY KEY("blob_id","ord"),
	CONSTRAINT "blob_chunks_size" CHECK (ord >= 0 and octet_length(data) <= 524288)
);
--> statement-breakpoint
ALTER TABLE "hive"."blob_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"media_type" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_org_sha256" UNIQUE("org_id","sha256"),
	CONSTRAINT "blobs_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "blobs_size" CHECK (size >= 0 and chunk_count >= 0),
	CONSTRAINT "blobs_sha256" CHECK (sha256 ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "hive"."blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD COLUMN "source" text DEFAULT 'hub' NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD COLUMN "repo_commit" text;--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD COLUMN "secret_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hive"."docs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hive"."doc_assets" ADD CONSTRAINT "doc_assets_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_conflicts" ADD CONSTRAINT "doc_conflicts_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_extracts" ADD CONSTRAINT "doc_extracts_asset_id_org_id_doc_assets_id_org_id_fk" FOREIGN KEY ("asset_id","org_id") REFERENCES "hive"."doc_assets"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_import_files" ADD CONSTRAINT "doc_import_files_import_id_org_id_doc_imports_id_org_id_fk" FOREIGN KEY ("import_id","org_id") REFERENCES "hive"."doc_imports"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_import_files" ADD CONSTRAINT "doc_import_files_asset_id_org_id_doc_assets_id_org_id_fk" FOREIGN KEY ("asset_id","org_id") REFERENCES "hive"."doc_assets"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_imports" ADD CONSTRAINT "doc_imports_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_repo_files" ADD CONSTRAINT "doc_repo_files_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_sync_batches" ADD CONSTRAINT "doc_sync_batches_home_id_org_id_doc_homes_id_org_id_fk" FOREIGN KEY ("home_id","org_id") REFERENCES "hive"."doc_homes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."doc_chunks" ADD CONSTRAINT "doc_chunks_doc_id_org_id_docs_id_org_id_fk" FOREIGN KEY ("doc_id","org_id") REFERENCES "hive"."docs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."blob_chunks" ADD CONSTRAINT "blob_chunks_blob_id_org_id_blobs_id_org_id_fk" FOREIGN KEY ("blob_id","org_id") REFERENCES "hive"."blobs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_assets_blob" ON "hive"."doc_assets" USING btree ("org_id","blob_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_conflicts_open" ON "hive"."doc_conflicts" USING btree ("doc_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "doc_conflicts_org_state" ON "hive"."doc_conflicts" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_extracts_approved" ON "hive"."doc_extracts" USING btree ("asset_id") WHERE state = 'approved';--> statement-breakpoint
CREATE INDEX "doc_extracts_org_state" ON "hive"."doc_extracts" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_homes_project" ON "hive"."doc_homes" USING btree ("org_id","project_id") WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "doc_homes_org" ON "hive"."doc_homes" USING btree ("org_id") WHERE scope = 'org';--> statement-breakpoint
CREATE INDEX "doc_homes_connection" ON "hive"."doc_homes" USING btree ("org_id","connection_id");--> statement-breakpoint
CREATE INDEX "doc_import_files_resume" ON "hive"."doc_import_files" USING btree ("org_id","import_id","state");--> statement-breakpoint
CREATE INDEX "doc_imports_home" ON "hive"."doc_imports" USING btree ("org_id","home_id","created_at");--> statement-breakpoint
CREATE INDEX "doc_repo_files_pending" ON "hive"."doc_repo_files" USING btree ("org_id","home_id","state");--> statement-breakpoint
CREATE INDEX "doc_sync_batches_home_state" ON "hive"."doc_sync_batches" USING btree ("org_id","home_id","state");--> statement-breakpoint
CREATE INDEX "doc_chunks_org" ON "hive"."doc_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "doc_chunks_search" ON "hive"."doc_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "blob_chunks_org" ON "hive"."blob_chunks" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "hive"."doc_versions" ADD CONSTRAINT "doc_versions_source" CHECK (source in ('hub', 'repo', 'import', 'merge'));--> statement-breakpoint
CREATE POLICY "doc_assets_rw" ON "hive"."doc_assets" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_conflicts_rw" ON "hive"."doc_conflicts" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_extracts_rw" ON "hive"."doc_extracts" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_homes_rw" ON "hive"."doc_homes" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_import_files_rw" ON "hive"."doc_import_files" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_imports_rw" ON "hive"."doc_imports" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_repo_files_rw" ON "hive"."doc_repo_files" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_sync_batches_rw" ON "hive"."doc_sync_batches" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "doc_chunks_rw" ON "hive"."doc_chunks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "blob_chunks_rw" ON "hive"."blob_chunks" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "blobs_rw" ON "hive"."blobs" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());
--> statement-breakpoint
-- Khóa ngoại cũng kiểm org_id vì kiểm tham chiếu không chịu RLS.
ALTER TABLE hive.doc_homes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_homes TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_homes FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_homes ADD CONSTRAINT doc_homes_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_repo_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_repo_files TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_repo_files FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_repo_files ADD CONSTRAINT doc_repo_files_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_sync_batches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_sync_batches TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_sync_batches FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_sync_batches ADD CONSTRAINT doc_sync_batches_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_conflicts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_conflicts TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_conflicts FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_conflicts ADD CONSTRAINT doc_conflicts_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_imports TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_imports FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_imports ADD CONSTRAINT doc_imports_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_import_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_import_files TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_import_files FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_import_files ADD CONSTRAINT doc_import_files_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_assets TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_assets FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_assets ADD CONSTRAINT doc_assets_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_extracts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_extracts TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_extracts FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_extracts ADD CONSTRAINT doc_extracts_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.doc_chunks TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.doc_chunks FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.doc_chunks ADD CONSTRAINT doc_chunks_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.blobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.blobs TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.blobs FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.blobs ADD CONSTRAINT blobs_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.blob_chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hive.blob_chunks TO hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.blob_chunks FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.blob_chunks ADD CONSTRAINT blob_chunks_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_homes ADD CONSTRAINT doc_homes_connection_id_org_fk FOREIGN KEY (connection_id, org_id) REFERENCES hive.scm_connections(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE hive.doc_homes ADD CONSTRAINT doc_homes_project_id_org_fk FOREIGN KEY (project_id, org_id) REFERENCES hive.projects(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_repo_files ADD CONSTRAINT doc_repo_files_doc_id_org_fk FOREIGN KEY (doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_conflicts ADD CONSTRAINT doc_conflicts_doc_id_org_fk FOREIGN KEY (doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.doc_import_files ADD CONSTRAINT doc_import_files_doc_id_org_fk FOREIGN KEY (doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE hive.doc_assets ADD CONSTRAINT doc_assets_owner_doc_id_org_fk FOREIGN KEY (owner_doc_id, org_id) REFERENCES hive.docs(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE hive.doc_assets ADD CONSTRAINT doc_assets_blob_id_org_fk FOREIGN KEY (blob_id, org_id) REFERENCES hive.blobs(id, org_id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE hive.doc_chunks ADD CONSTRAINT doc_chunks_extract_id_org_fk FOREIGN KEY (extract_id, org_id) REFERENCES hive.doc_extracts(id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
-- Chủ bảng cũng chịu FORCE RLS; chỉ tắt FORCE trong transaction migration để điền mọi tổ chức.
ALTER TABLE hive.doc_versions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE hive.doc_versions SET content_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex') WHERE content_hash IS NULL;
--> statement-breakpoint
ALTER TABLE hive.doc_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Giữ nguyên byte của lịch sử; phiên bản mới do đường lưu tài liệu tính hash sau khi chuẩn hóa theo nguồn.
CREATE FUNCTION hive.enable_doc_vectors() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE ns text;
BEGIN
  SELECT extnamespace::regnamespace::text INTO ns FROM pg_extension WHERE extname = 'vector';
  IF ns IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE hive.doc_chunks ADD COLUMN IF NOT EXISTS embedding %I.vector', ns);
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION hive.enable_doc_vectors() FROM PUBLIC, hive_app;
--> statement-breakpoint
SELECT hive.enable_doc_vectors();
