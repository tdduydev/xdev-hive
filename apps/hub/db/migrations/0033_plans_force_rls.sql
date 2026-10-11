-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS; default privileges chưa cấp, thu lại cho chắc.
REVOKE TRUNCATE ON TABLE hive.plans FROM hive_app;
--> statement-breakpoint
-- Khoá kép theo tổ chức sang bảng của module runs và tenancy (schema.ts của tasks không import được bảng của module
-- khác). Run bị xoá thì kế hoạch của nó mất nghĩa, như run_events.
ALTER TABLE hive.plans ADD CONSTRAINT plans_run_fk
  FOREIGN KEY (run_id, org_id) REFERENCES hive.runs (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.plans ADD CONSTRAINT plans_plan_run_fk
  FOREIGN KEY (plan_run_id, org_id) REFERENCES hive.runs (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.plans ADD CONSTRAINT plans_team_fk
  FOREIGN KEY (team_id, org_id) REFERENCES hive.teams (id, org_id) ON UPDATE CASCADE ON DELETE RESTRICT;
