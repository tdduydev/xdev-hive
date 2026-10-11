-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS; default privileges chưa cấp, thu lại cho chắc.
REVOKE TRUNCATE ON TABLE hive.webhook_deliveries FROM hive_app;
--> statement-breakpoint
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì delivery trỏ được tới dự án của tổ chức khác.
-- Xoá dự án thì lịch sử webhook của nó đi theo.
ALTER TABLE hive.webhook_deliveries ADD CONSTRAINT webhook_deliveries_project_fk
  FOREIGN KEY (project_id, org_id) REFERENCES hive.projects (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.webhook_deliveries ADD CONSTRAINT webhook_deliveries_org_fk
  FOREIGN KEY (org_id) REFERENCES hive.orgs (id) ON DELETE CASCADE;
