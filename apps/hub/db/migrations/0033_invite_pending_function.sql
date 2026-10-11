-- Hub chỉ tạo tài khoản cho người được mời. Đăng nhập GitHub/GitLab không mang mã mời, nên cần biết email đó có lời
-- mời còn hạn ở tổ chức nào không, trong khi hive_app chỉ thấy lời mời của tổ chức trong context. Lộ đúng một bit qua
-- hàm SECURITY DEFINER (như hive.any_org) thay vì nới RLS. Lời mời luôn lưu email chữ thường.
CREATE FUNCTION hive.invite_pending(p_email text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM hive.invitations
    WHERE email = lower(p_email) AND accepted_at IS NULL AND expires_at > now()
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.invite_pending(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.invite_pending(text) TO hive_app;
