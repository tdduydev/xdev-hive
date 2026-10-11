-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.machines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.machine_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.registration_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- TRUNCATE không qua RLS; default privileges chưa cấp, thu lại cho chắc.
REVOKE TRUNCATE ON TABLE hive.machines, hive.machine_tokens, hive.registration_tokens FROM hive_app;
