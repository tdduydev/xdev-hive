-- FORCE để cả chủ bảng cũng chịu RLS nếu lỡ kết nối bằng hive_owner.
ALTER TABLE hive.orgs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.org_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.teams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.team_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.systems FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hive.invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA hive TO hive_app;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hive TO hive_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hive TO hive_app;
--> statement-breakpoint
-- Bảng tạo ở migration sau tự cấp quyền cho hive_app; RLS vẫn phải bật riêng cho từng bảng (có test kiểm).
ALTER DEFAULT PRIVILEGES IN SCHEMA hive GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hive_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA hive GRANT EXECUTE ON FUNCTIONS TO hive_app;
--> statement-breakpoint
-- Bảng theo dõi migration nằm trong schema hive nhưng app không được đụng.
REVOKE ALL ON TABLE hive.migrations FROM hive_app;
