-- Job dọn artifact (artifacts/purge.ts) chạy không có tổ chức trong context nên không thấy dòng nào qua RLS. Hàm trả các
-- tổ chức có artifact để job mở withTenant cho từng tổ chức (dọn liên kết mồ côi, thu hồi link của chủ đã rời tổ chức).
-- Chỉ trả id tổ chức, không trả cột nào khác.
CREATE FUNCTION hive.artifact_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT a.org_id FROM hive.artifacts AS a
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.artifact_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.artifact_orgs() TO hive_app;
