-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Nhật ký append-only: default privileges của schema hive cấp đủ bốn quyền, nên phải thu lại UPDATE và DELETE.
-- TRUNCATE không qua RLS, thu luôn cho chắc dù default privileges chưa cấp.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE hive.audit_log FROM hive_app;
