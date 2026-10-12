CREATE TABLE "hive"."audit_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_settings_retention_days" CHECK ("hive"."audit_settings"."retention_days" BETWEEN 90 AND 3650)
);
--> statement-breakpoint
ALTER TABLE "hive"."audit_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Thời hạn lưu hiệu lực của một tổ chức: mặc định 365 ngày khi chưa cấu hình, không dưới 90 dù CHECK của
-- audit_settings đã chặn, vì policy xoá của audit_log dựa vào nó. Phải có trước các policy dùng nó. Chạy bằng quyền người
-- gọi; chỉ policy của hive_owner (chủ hàm) gọi tới.
CREATE FUNCTION hive.audit_retention_days(p_org uuid) RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT greatest(90, coalesce((SELECT s.retention_days FROM hive.audit_settings AS s WHERE s.org_id = p_org), 365))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.audit_retention_days(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY "audit_log_owner_purge_select" ON "hive"."audit_log" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (created_at < now() - make_interval(days => hive.audit_retention_days(org_id)));--> statement-breakpoint
CREATE POLICY "audit_log_owner_purge" ON "hive"."audit_log" AS PERMISSIVE FOR DELETE TO "hive_owner" USING (created_at < now() - make_interval(days => hive.audit_retention_days(org_id)));--> statement-breakpoint
CREATE POLICY "audit_log_owner_purge_record" ON "hive"."audit_log" AS PERMISSIVE FOR INSERT TO "hive_owner" WITH CHECK (action = 'audit.purge' AND actor_user_id IS NULL);--> statement-breakpoint
CREATE POLICY "audit_settings_select" ON "hive"."audit_settings" AS PERMISSIVE FOR SELECT TO "hive_app" USING (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "audit_settings_insert" ON "hive"."audit_settings" AS PERMISSIVE FOR INSERT TO "hive_app" WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "audit_settings_update" ON "hive"."audit_settings" AS PERMISSIVE FOR UPDATE TO "hive_app" USING (org_id = hive.ctx_org()) WITH CHECK (org_id = hive.ctx_org());--> statement-breakpoint
CREATE POLICY "audit_settings_owner_select" ON "hive"."audit_settings" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.audit_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Default privileges của schema hive cấp DELETE: thu lại để xoá cấu hình (đưa thời hạn về mặc định mà không có audit)
-- báo lỗi quyền thay vì lặng lẽ không xoá dòng nào.
REVOKE DELETE, TRUNCATE ON TABLE hive.audit_settings FROM hive_app;
--> statement-breakpoint
-- OPS-07: job hằng ngày của module audit xoá dòng nhật ký quá thời hạn lưu của từng tổ chức. hive_app không có DELETE
-- trên audit_log nên việc xoá đi qua hàm SECURITY DEFINER này. Hàm không nhận tham số để người gọi không chọn được dòng
-- hay mốc thời gian; policy của chủ hàm chỉ để lộ dòng đã quá hạn, nên gọi bao nhiêu lần cũng không xoá sớm được. Mỗi
-- tổ chức bị xoá dòng có thêm một dòng audit.purge ghi số dòng, thời hạn và mốc đã áp. INSERT không có RETURNING vì dòng
-- mới không qua được policy đọc của hive_owner.
CREATE FUNCTION hive.purge_expired_audit_log() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_total integer;
BEGIN
  WITH deleted AS (
    DELETE FROM hive.audit_log AS a
    WHERE a.created_at < now() - interval '90 days'
      AND a.created_at < now() - make_interval(days => hive.audit_retention_days(a.org_id))
    RETURNING a.org_id
  ), counts AS (
    SELECT d.org_id, count(*)::integer AS n FROM deleted AS d GROUP BY d.org_id
  ), recorded AS (
    INSERT INTO hive.audit_log (org_id, actor_user_id, action, target_type, data)
    SELECT c.org_id, NULL, 'audit.purge', 'audit_log', jsonb_build_object(
      'deleted', c.n,
      'retentionDays', hive.audit_retention_days(c.org_id),
      'before', now() - make_interval(days => hive.audit_retention_days(c.org_id))
    )
    FROM counts AS c
  )
  SELECT coalesce(sum(c.n), 0)::integer INTO v_total FROM counts AS c;
  RETURN v_total;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_expired_audit_log() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_expired_audit_log() TO hive_app;
