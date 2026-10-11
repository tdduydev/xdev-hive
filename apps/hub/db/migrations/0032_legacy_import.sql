CREATE TABLE "hive"."legacy_doc_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_import_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"storage_locator" text,
	"status" text DEFAULT 'missing' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_doc_assets_source" UNIQUE("org_id","source_id"),
	CONSTRAINT "legacy_doc_assets_status" CHECK (status in ('missing', 'available')),
	CONSTRAINT "legacy_doc_assets_size" CHECK (size >= 0)
);
--> statement-breakpoint
ALTER TABLE "hive"."legacy_doc_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."legacy_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_ids" uuid[] NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_imports_source" UNIQUE("org_id","kind","source_id"),
	CONSTRAINT "legacy_imports_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "legacy_imports_kind" CHECK (kind in ('memory', 'doc', 'skill', 'asset'))
);
--> statement-breakpoint
ALTER TABLE "hive"."legacy_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."legacy_doc_assets" ADD CONSTRAINT "legacy_doc_assets_document_import_id_org_id_legacy_imports_id_org_id_fk" FOREIGN KEY ("document_import_id","org_id") REFERENCES "hive"."legacy_imports"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_doc_assets_document" ON "hive"."legacy_doc_assets" USING btree ("document_import_id","org_id");--> statement-breakpoint
CREATE POLICY "legacy_doc_assets_rw" ON "hive"."legacy_doc_assets" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "legacy_imports_rw" ON "hive"."legacy_imports" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
ALTER TABLE hive.legacy_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.legacy_doc_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON hive.legacy_imports, hive.legacy_doc_assets FROM hive_app;
--> statement-breakpoint
ALTER TABLE hive.legacy_imports ADD CONSTRAINT legacy_imports_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.legacy_doc_assets ADD CONSTRAINT legacy_doc_assets_org_fk FOREIGN KEY (org_id) REFERENCES hive.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Slug phải được giải trước khi có tenant. Chỉ trả id của một tổ chức; không cấp SELECT toàn bảng cho hive_app.
-- FORCE RLS vẫn chạy: policy orgs_owner_select có sẵn cho chủ hàm hive_owner.
CREATE FUNCTION hive.legacy_import_org(target_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hive
AS $$ SELECT id FROM hive.orgs WHERE slug = target_slug $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.legacy_import_org(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.legacy_import_org(text) TO hive_app;
