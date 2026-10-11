-- Hub chỉ nhận người được mời, nhưng vẫn có thể còn tài khoản không thuộc tổ chức nào: lời mời bị thu hồi hoặc hết hạn
-- sau khi tài khoản GitHub/GitLab đã được tạo nhờ nó, hay người bị gỡ khỏi mọi tổ chức. Job dọn định kỳ của hub gọi hàm
-- này. hive_app không đọc được thành viên và lời mời của tổ chức khác, cũng không có quyền trên schema auth, nên việc
-- này đi qua hàm SECURITY DEFINER (như hive.invite_pending) thay vì nới RLS. Hạn 7 ngày nằm cứng trong hàm để hive_app
-- không xoá được tài khoản vừa tạo, còn đang chờ nhận lời mời. Tài khoản dính khoá ngoại không cascade (nhà cung cấp
-- SSO do người đó đăng ký sẽ bị xoá theo, token MCP chặn việc xoá) được bỏ qua để quản trị hub tự xử lý.
CREATE FUNCTION hive.purge_orphan_users(p_keep_emails text[]) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id text;
  v_count integer := 0;
BEGIN
  FOR v_id IN
    SELECT u.id FROM auth."user" u
    WHERE u."createdAt" < now() - interval '7 days'
      AND lower(u.email) <> ALL (coalesce(p_keep_emails, '{}'::text[]))
      AND NOT EXISTS (SELECT 1 FROM hive.org_members m WHERE m.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1 FROM hive.invitations i
        WHERE i.email = lower(u.email) AND i.accepted_at IS NULL AND i.expires_at > now()
      )
      AND NOT EXISTS (SELECT 1 FROM auth."ssoProvider" p WHERE p."userId" = u.id)
      AND NOT EXISTS (SELECT 1 FROM auth."oauthClient" c WHERE c."userId" = u.id)
      AND NOT EXISTS (SELECT 1 FROM auth."oauthConsent" c WHERE c."userId" = u.id)
      AND NOT EXISTS (SELECT 1 FROM auth."oauthAccessToken" t WHERE t."userId" = u.id)
      AND NOT EXISTS (SELECT 1 FROM auth."oauthRefreshToken" t WHERE t."userId" = u.id)
  LOOP
    -- Khoá dòng rồi kiểm lại bằng snapshot mới của câu lệnh sau. Nhận lời mời cùng lúc phải khoá dòng người dùng (khoá
    -- ngoại của org_members): hoặc nó chờ việc xoá xong rồi hỏng, hoặc nó xong trước và lần kiểm này thấy dòng thành
    -- viên. Dòng đang bị khoá thì để lần chạy sau.
    PERFORM 1 FROM auth."user" u WHERE u.id = v_id FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (SELECT 1 FROM hive.org_members m WHERE m.user_id = v_id);
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM hive.invitations i JOIN auth."user" u ON i.email = lower(u.email)
      WHERE u.id = v_id AND i.accepted_at IS NULL AND i.expires_at > now()
    );
    DELETE FROM auth."user" WHERE id = v_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.purge_orphan_users(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.purge_orphan_users(text[]) TO hive_app;
