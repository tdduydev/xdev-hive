-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.merge_queue_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS; default privileges chưa cấp, thu lại cho chắc.
REVOKE TRUNCATE ON TABLE hive.merge_queue_entries FROM hive_app;
--> statement-breakpoint
-- Khoá kép theo tổ chức sang bảng của module runs và tasks (schema.ts của catalog không import được bảng của module
-- khác). Xoá run hay task không xoá lịch sử merge, chỉ bỏ liên kết; SET NULL chỉ cột id vì org_id bắt buộc.
ALTER TABLE hive.merge_queue_entries ADD CONSTRAINT merge_queue_entries_run_fk
  FOREIGN KEY (run_id, org_id) REFERENCES hive.runs (id, org_id) ON DELETE SET NULL (run_id);
--> statement-breakpoint
ALTER TABLE hive.merge_queue_entries ADD CONSTRAINT merge_queue_entries_task_fk
  FOREIGN KEY (task_id, org_id) REFERENCES hive.tasks (id, org_id) ON DELETE SET NULL (task_id);
