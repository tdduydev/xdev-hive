-- Hàm đọc tenant context do withTenant() đặt bằng set_config(..., true). Policy RLS chỉ gọi các hàm này,
-- để mọi bảng dùng chung một cách đọc context và giá trị rỗng thành NULL (không khớp dòng nào).
CREATE SCHEMA IF NOT EXISTS "hive";
--> statement-breakpoint
CREATE FUNCTION hive.ctx_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION hive.ctx_user() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;
--> statement-breakpoint
CREATE FUNCTION hive.ctx_invite() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.invite_token_hash', true), '')
$$;
