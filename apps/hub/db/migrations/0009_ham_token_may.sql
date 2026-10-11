-- Worker và người cài máy gọi hub bằng token, không có phiên người dùng nên chưa biết tổ chức. Module fleet đặt băm
-- của token vào app.fleet_token_hash trong transaction; policy SELECT của machine_tokens và registration_tokens cho
-- thấy đúng dòng có băm đó, giống invitations dùng ctx_invite. Không dùng SECURITY DEFINER vì bảng bị FORCE RLS
-- nên hàm chạy bằng chủ bảng vẫn không thấy dòng nào nếu không nới thêm policy cho chủ bảng.
CREATE FUNCTION hive.ctx_fleet_token() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.fleet_token_hash', true), '')
$$;
