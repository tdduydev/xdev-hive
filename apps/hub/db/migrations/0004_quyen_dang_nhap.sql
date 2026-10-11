-- Schema auth thuộc Better Auth và chỉ hive_auth được đọc ghi. Không bật RLS: đây là danh tính dùng chung
-- cho mọi tổ chức, và hive_app không có quyền gì ở đây ngoài đọc vài cột hồ sơ.
GRANT USAGE ON SCHEMA auth TO hive_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO hive_auth;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hive_auth;
--> statement-breakpoint
-- Hub cần tên và email để hiện danh sách thành viên; không bao giờ đọc mật khẩu hay token.
GRANT USAGE ON SCHEMA auth TO hive_app;
--> statement-breakpoint
GRANT SELECT (id, name, email, image) ON auth."user" TO hive_app;
