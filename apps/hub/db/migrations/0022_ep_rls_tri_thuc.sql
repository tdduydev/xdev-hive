-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.memories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.docs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.doc_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.skills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.skill_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS. Phiên bản là lịch sử: hub chỉ thêm, không sửa không xoá (xoá tài liệu thì cascade).
REVOKE TRUNCATE ON TABLE hive.memories, hive.docs, hive.doc_versions, hive.skills, hive.skill_versions, hive.proposals FROM hive_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE hive.doc_versions, hive.skill_versions FROM hive_app;
--> statement-breakpoint
-- Khoá ngoại sang bảng của module khác viết tay, vì schema.ts của module không được import bảng của tenancy/catalog.
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì mục tri thức trỏ được tới đội của tổ chức khác.
ALTER TABLE hive.projects ADD CONSTRAINT projects_id_team_org UNIQUE (id, team_id, org_id);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memories', 'docs', 'skills', 'proposals'] LOOP
    EXECUTE format('ALTER TABLE hive.%I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES hive.orgs (id) ON DELETE CASCADE',
      t, t || '_org_fk');
    EXECUTE format('ALTER TABLE hive.%I ADD CONSTRAINT %I FOREIGN KEY (team_id, org_id) REFERENCES hive.teams (id, org_id) ON UPDATE CASCADE ON DELETE CASCADE',
      t, t || '_team_fk');
    -- (project_id, team_id) trỏ tới dự án kèm đội của nó: team_id của mục không lệch khỏi dự án, và dự án chuyển
    -- đội (đổi hệ thống) thì mục đi theo. project_id null thì khoá ngoại không kiểm (MATCH SIMPLE).
    EXECUTE format('ALTER TABLE hive.%I ADD CONSTRAINT %I FOREIGN KEY (project_id, team_id, org_id) REFERENCES hive.projects (id, team_id, org_id) ON UPDATE CASCADE ON DELETE CASCADE',
      t, t || '_project_fk');
  END LOOP;
END $$;
--> statement-breakpoint
-- Cột embedding chỉ có khi database cài pgvector. Extension vector không phải trusted nên hive_owner không tự tạo
-- được: bootstrapRoles (superuser) tạo nếu image có sẵn, migration này chỉ thêm cột khi extension đã có. Cài pgvector
-- về sau thì chạy lại db:setup; runMigrations gọi lại hàm này sau mỗi lần migrate. Không ghi số chiều để đổi được
-- mô hình embedding (mỗi mô hình một số chiều); cột embedding_model giữ việc chỉ so vector cùng mô hình.
CREATE FUNCTION hive.enable_memory_vectors() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE ns text;
BEGIN
  SELECT extnamespace::regnamespace::text INTO ns FROM pg_extension WHERE extname = 'vector';
  IF ns IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('ALTER TABLE hive.memories ADD COLUMN IF NOT EXISTS embedding %I.vector', ns);
  RETURN true;
END $$;
--> statement-breakpoint
-- Chỉ chủ bảng chạy được ALTER; default privileges cấp EXECUTE cho hive_app, thu lại để khỏi gọi nhầm.
REVOKE EXECUTE ON FUNCTION hive.enable_memory_vectors() FROM PUBLIC, hive_app;
--> statement-breakpoint
SELECT hive.enable_memory_vectors();
