CREATE TYPE "hive"."artifact_link_kind" AS ENUM('chat_thread', 'terminal_session', 'run', 'task', 'sdlc_item', 'doc');--> statement-breakpoint
CREATE TYPE "hive"."artifact_origin" AS ENUM('leader', 'terminal', 'run', 'mcp', 'manual');--> statement-breakpoint
CREATE TYPE "hive"."artifact_scope" AS ENUM('private', 'project', 'team', 'org');--> statement-breakpoint
CREATE TYPE "hive"."artifact_type" AS ENUM('markdown', 'code', 'html', 'react', 'svg', 'mermaid', 'csv', 'json', 'image', 'pdf');--> statement-breakpoint
CREATE TABLE "hive"."artifact_links" (
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"target_kind" "hive"."artifact_link_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_links_artifact_id_target_kind_target_id_pk" PRIMARY KEY("artifact_id","target_kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "hive"."artifact_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."artifact_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" "hive"."artifact_type" NOT NULL,
	"content" text NOT NULL,
	"compiled" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hive"."artifact_previews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."artifact_public_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"token_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"view_count" bigint DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "artifact_public_links_token_sha256_unique" UNIQUE("token_sha256"),
	CONSTRAINT "artifact_public_links_expiry" CHECK (expires_at > created_at),
	CONSTRAINT "artifact_public_links_revoke_reason" CHECK (revoke_reason in ('manual', 'deleted', 'owner_changed', 'tombstoned', 'owner_left', 'org_disabled'))
);
--> statement-breakpoint
ALTER TABLE "hive"."artifact_public_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text,
	"blob_id" uuid,
	"compiled" text,
	"compile_error" text,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"author_user_id" text,
	"author_run_id" uuid,
	"origin" "hive"."artifact_origin" NOT NULL,
	"message" text,
	"name" text,
	"restored_from" integer,
	"tombstoned_at" timestamp with time zone,
	"tombstoned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifact_version" UNIQUE("artifact_id","version"),
	CONSTRAINT "artifact_versions_author" CHECK ((author_user_id is null) <> (author_run_id is null)),
	CONSTRAINT "artifact_versions_message_len" CHECK (char_length(message) <= 500),
	CONSTRAINT "artifact_versions_name_len" CHECK (char_length(name) <= 80)
);
--> statement-breakpoint
ALTER TABLE "hive"."artifact_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hive"."artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" "hive"."artifact_scope" DEFAULT 'private' NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"origin_project_id" uuid,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"type" "hive"."artifact_type" NOT NULL,
	"language" text,
	"origin" "hive"."artifact_origin" NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"duplicated_from_id" uuid,
	"duplicated_from_version" integer,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"search" "tsvector",
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "artifacts_title_len" CHECK (char_length(title) between 1 and 200),
	CONSTRAINT "artifacts_project_scope" CHECK ((scope = 'project') = (project_id is not null)),
	CONSTRAINT "artifacts_team_scope" CHECK (scope not in ('project', 'team') or team_id is not null),
	CONSTRAINT "artifacts_team_only_scoped" CHECK (scope in ('project', 'team') or team_id is null)
);
--> statement-breakpoint
ALTER TABLE "hive"."artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."chat_messages" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "hive"."chat_messages" ADD COLUMN "artifact_version" integer;--> statement-breakpoint
ALTER TABLE "hive"."chat_messages" ADD COLUMN "page_errors" jsonb;--> statement-breakpoint
ALTER TABLE "hive"."artifact_links" ADD CONSTRAINT "artifact_links_artifact_id_org_id_artifacts_id_org_id_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."artifacts"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."artifact_public_links" ADD CONSTRAINT "artifact_public_links_artifact_id_org_id_artifacts_id_org_id_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."artifacts"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hive"."artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_org_id_artifacts_id_org_id_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."artifacts"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_links_target" ON "hive"."artifact_links" USING btree ("org_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "artifact_previews_expires" ON "hive"."artifact_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "artifact_previews_org_user" ON "hive"."artifact_previews" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "artifact_public_links_active" ON "hive"."artifact_public_links" USING btree ("org_id","artifact_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "artifact_public_links_expires" ON "hive"."artifact_public_links" USING btree ("org_id","expires_at") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "artifact_versions_author_run" ON "hive"."artifact_versions" USING btree ("author_run_id") WHERE author_run_id is not null;--> statement-breakpoint
CREATE INDEX "artifacts_org_updated" ON "hive"."artifacts" USING btree ("org_id","updated_at" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "artifacts_org_owner" ON "hive"."artifacts" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "artifacts_org_project" ON "hive"."artifacts" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "artifacts_deleted_at" ON "hive"."artifacts" USING btree ("deleted_at") WHERE deleted_at is not null;--> statement-breakpoint
CREATE INDEX "artifacts_search" ON "hive"."artifacts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "chat_messages_artifact" ON "hive"."chat_messages" USING btree ("artifact_id") WHERE artifact_id is not null;--> statement-breakpoint
CREATE POLICY "artifact_links_rw" ON "hive"."artifact_links" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_previews_rw" ON "hive"."artifact_previews" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_previews_owner_select" ON "hive"."artifact_previews" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "artifact_previews_owner_purge" ON "hive"."artifact_previews" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "artifact_public_links_rw" ON "hive"."artifact_public_links" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_public_links_owner_select" ON "hive"."artifact_public_links" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "artifact_public_links_owner_purge" ON "hive"."artifact_public_links" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "artifact_versions_select" ON "hive"."artifact_versions" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_versions_insert" ON "hive"."artifact_versions" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_versions_owner_select" ON "hive"."artifact_versions" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifact_versions_owner_update" ON "hive"."artifact_versions" AS PERMISSIVE FOR UPDATE TO "hive_owner" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifacts_rw" ON "hive"."artifacts" AS PERMISSIVE FOR ALL TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "artifacts_owner_select" ON "hive"."artifacts" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "artifacts_owner_purge" ON "hive"."artifacts" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (true);
--> statement-breakpoint
-- Viết tay: khoá ngoại từ tin nhắn chat. `set null (artifact_id)` (Postgres 15+) chỉ xoá artifact_id; set null cả khoá
-- ghép sẽ làm org_id null và vỡ RLS. Tin nhắn thẻ của artifact bị xoá hẳn thành tin nhắn thường.
ALTER TABLE "hive"."chat_messages" ADD CONSTRAINT "chat_messages_artifact_id_org_id_artifacts_id_org_id_fk" FOREIGN KEY ("artifact_id","org_id") REFERENCES "hive"."artifacts"("id","org_id") ON DELETE set null ("artifact_id") ON UPDATE no action;--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE "hive"."artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."artifact_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."artifact_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."artifact_previews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hive"."artifact_public_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Lịch sử phiên bản bất biến bằng quyền database: hive_app chỉ insert/select (policy ở trên cũng chỉ có hai lệnh này).
-- Xoá dòng chỉ xảy ra khi xoá hẳn artifact (cascade chạy bằng quyền chủ bảng).
REVOKE UPDATE, DELETE ON "hive"."artifact_versions" FROM hive_app;--> statement-breakpoint
-- Xoá vì lộ bí mật: bỏ nội dung của một phiên bản nhưng giữ dòng (số phiên bản, tác giả, băm) để lịch sử không thủng.
-- Hub kiểm quyền người gọi trước; hàm chỉ chạm phiên bản của tổ chức trong context. Trả false khi không có hoặc đã xoá.
CREATE FUNCTION hive.artifact_tombstone(version_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH changed AS (
    UPDATE hive.artifact_versions AS v
    SET content = NULL, compiled = NULL, compile_error = NULL, tombstoned_at = now(), tombstoned_by = hive.ctx_user()
    WHERE v.id = $1 AND v.org_id = hive.ctx_org() AND v.tombstoned_at IS NULL
    RETURNING 1
  )
  SELECT count(*) > 0 FROM changed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.artifact_tombstone(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.artifact_tombstone(uuid) TO hive_app;
--> statement-breakpoint
-- Đặt hoặc xoá (null) tên của một phiên bản; ràng buộc độ dài do check của cột. Trả false khi không có phiên bản.
CREATE FUNCTION hive.artifact_version_rename(version_id uuid, new_name text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH changed AS (
    UPDATE hive.artifact_versions AS v
    SET name = nullif(btrim($2), '')
    WHERE v.id = $1 AND v.org_id = hive.ctx_org()
    RETURNING 1
  )
  SELECT count(*) > 0 FROM changed
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.artifact_version_rename(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.artifact_version_rename(uuid, text) TO hive_app;
--> statement-breakpoint
-- Người xem link công khai không đăng nhập nên context chưa có tổ chức. Hàm đổi băm của mã thành (org_id, link_id), chỉ
-- khi link chưa thu hồi và chưa hết hạn, và không trả cột nào khác; hub kiểm tiếp artifact, phiên bản, chính sách trong
-- withTenant(org_id). Hết hạn, thu hồi và mã sai đều cho kết quả rỗng như nhau.
CREATE FUNCTION hive.artifact_public_link_resolve(token_sha256 text) RETURNS TABLE (org_id uuid, link_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.org_id, l.id FROM hive.artifact_public_links AS l
  WHERE l.token_sha256 = $1 AND l.revoked_at IS NULL AND l.expires_at > now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.artifact_public_link_resolve(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.artifact_public_link_resolve(text) TO hive_app;
--> statement-breakpoint
-- Dọn hằng ngày, không có tổ chức trong context nên cần SECURITY DEFINER: xoá hẳn artifact trong thùng rác quá hạn
-- (phiên bản, liên kết, link công khai đi theo cascade; thẻ chat về artifact_id = null), bản xem trước hết hạn, và link
-- công khai đã hết hạn quá link_days. Hạn truyền vào chỉ được dài hơn mặc định (30 và 90 ngày), không rút ngắn được.
-- Trả số dòng đã xoá theo tổ chức để hub ghi audit `artifact.purge` cho từng tổ chức.
CREATE FUNCTION hive.artifact_purge(trash_days integer DEFAULT 30, link_days integer DEFAULT 90) RETURNS TABLE (org_id uuid, artifacts integer, previews integer, public_links integer) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH a AS (
    DELETE FROM hive.artifacts AS x
    WHERE x.deleted_at < now() - make_interval(days => greatest(30, $1))
    RETURNING x.org_id
  ), p AS (
    DELETE FROM hive.artifact_previews AS x WHERE x.expires_at < now() RETURNING x.org_id
  ), l AS (
    DELETE FROM hive.artifact_public_links AS x
    WHERE x.expires_at < now() - make_interval(days => greatest(90, $2))
    RETURNING x.org_id
  ), gone AS (
    SELECT a.org_id, 1 AS k FROM a
    UNION ALL SELECT p.org_id, 2 FROM p
    UNION ALL SELECT l.org_id, 3 FROM l
  )
  SELECT g.org_id, (count(*) FILTER (WHERE g.k = 1))::integer, (count(*) FILTER (WHERE g.k = 2))::integer, (count(*) FILTER (WHERE g.k = 3))::integer
  FROM gone AS g GROUP BY g.org_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.artifact_purge(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.artifact_purge(integer, integer) TO hive_app;
