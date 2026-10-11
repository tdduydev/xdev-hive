-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.run_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.run_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.run_leases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- run_events là append-only (docs/architecture.md mục 3): default privileges của schema hive cấp đủ bốn quyền, nên
-- thu lại UPDATE và DELETE. TRUNCATE không qua RLS, thu ở mọi bảng mới.
REVOKE UPDATE, DELETE ON TABLE hive.run_events FROM hive_app;
--> statement-breakpoint
REVOKE TRUNCATE ON TABLE hive.tasks, hive.runs, hive.run_events, hive.run_logs, hive.run_leases FROM hive_app;
--> statement-breakpoint
-- Khoá ngoại sang bảng của module khác viết tay, vì schema.ts của module không được import bảng của module khác.
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì dòng trỏ được tới dự án của tổ chức khác.
-- RESTRICT: dự án hay đội còn task thì không xoá lặng lẽ mất lịch sử.
ALTER TABLE hive.tasks ADD CONSTRAINT tasks_project_fk
  FOREIGN KEY (project_id, org_id) REFERENCES hive.projects (id, org_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE hive.tasks ADD CONSTRAINT tasks_team_fk
  FOREIGN KEY (team_id, org_id) REFERENCES hive.teams (id, org_id) ON UPDATE CASCADE ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE hive.runs ADD CONSTRAINT runs_task_fk
  FOREIGN KEY (task_id, org_id) REFERENCES hive.tasks (id, org_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE hive.runs ADD CONSTRAINT runs_project_fk
  FOREIGN KEY (project_id, org_id) REFERENCES hive.projects (id, org_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE hive.runs ADD CONSTRAINT runs_team_fk
  FOREIGN KEY (team_id, org_id) REFERENCES hive.teams (id, org_id) ON UPDATE CASCADE ON DELETE RESTRICT;
--> statement-breakpoint
-- Lease trỏ tới máy cùng tổ chức; máy bị xoá thì lease vô nghĩa.
ALTER TABLE hive.run_leases ADD CONSTRAINT run_leases_machine_fk
  FOREIGN KEY (machine_id, org_id) REFERENCES hive.machines (id, org_id) ON DELETE CASCADE;
