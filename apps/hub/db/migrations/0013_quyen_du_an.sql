-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.scm_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.project_provision_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Khoá ngoại sang bảng của module khác viết tay, vì schema.ts của module không được import bảng của tenancy.
ALTER TABLE hive.scm_connections ADD CONSTRAINT scm_connections_org_fk
  FOREIGN KEY (org_id) REFERENCES hive.orgs (id) ON DELETE CASCADE;
--> statement-breakpoint
-- Cặp (id, team_id) duy nhất để projects trỏ được tới hệ thống kèm đội của nó: team_id của dự án không thể lệch
-- khỏi hệ thống, và chuyển hệ thống sang đội khác thì dự án đi theo (ON UPDATE CASCADE).
ALTER TABLE hive.systems ADD CONSTRAINT systems_id_team UNIQUE (id, team_id);
--> statement-breakpoint
ALTER TABLE hive.projects ADD CONSTRAINT projects_system_fk
  FOREIGN KEY (system_id, team_id) REFERENCES hive.systems (id, team_id) ON UPDATE CASCADE ON DELETE RESTRICT;
--> statement-breakpoint
-- Khoá kép theo tổ chức: khoá ngoại bỏ qua RLS, thiếu org_id thì dự án trỏ được tới đội của tổ chức khác.
-- RESTRICT: xoá đội, hệ thống hay kết nối Git đang có dự án phải bị chặn, không lặng lẽ xoá dự án và mất dấu repo.
ALTER TABLE hive.projects ADD CONSTRAINT projects_team_fk
  FOREIGN KEY (team_id, org_id) REFERENCES hive.teams (id, org_id) ON UPDATE CASCADE ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE hive.projects ADD CONSTRAINT projects_scm_connection_fk
  FOREIGN KEY (scm_connection_id, org_id) REFERENCES hive.scm_connections (id, org_id) ON DELETE RESTRICT;
