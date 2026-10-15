CREATE POLICY "doc_homes_owner_select" ON "hive"."doc_homes" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
-- Tổ chức có nhà tài liệu đang chạy. Cron kéo repo chạy không có tổ chức trong context nên cần SECURITY DEFINER;
-- hàm chỉ trả id tổ chức, việc đọc nhà chạy lại trong từng tổ chức.
CREATE FUNCTION hive.docsync_active_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT h.org_id FROM hive.doc_homes AS h WHERE h.status = 'active' AND h.mode <> 'off'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.docsync_active_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.docsync_active_orgs() TO hive_app;
