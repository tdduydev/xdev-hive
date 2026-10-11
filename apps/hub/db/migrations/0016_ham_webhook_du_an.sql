-- GitHub/GitLab gọi /hooks/git/{projectId} không có phiên người dùng nên chưa biết tổ chức. Module catalog đặt id dự
-- án vào app.webhook_project_id trong transaction; policy SELECT của projects cho thấy đúng dòng có id đó, giống
-- ctx_fleet_token của fleet. Không dùng SECURITY DEFINER vì bảng bị FORCE RLS.
CREATE FUNCTION hive.ctx_webhook_project() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.webhook_project_id', true), '')::uuid
$$;
