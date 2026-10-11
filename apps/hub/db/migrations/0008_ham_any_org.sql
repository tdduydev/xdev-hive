-- hive_app chỉ thấy tổ chức mình là thành viên, nên không tự biết hub đã có tổ chức nào chưa. Quy tắc "người đầu
-- tiên tạo tổ chức" cần đúng một bit này, nên lộ ra qua hàm SECURITY DEFINER chỉ trả boolean thay vì nới RLS.
-- search_path rỗng để hàm không bị đánh tráo bảng qua schema khác.
CREATE FUNCTION hive.any_org() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM hive.orgs)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.any_org() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.any_org() TO hive_app;
