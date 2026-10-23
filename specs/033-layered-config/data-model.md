# Dữ liệu cấu hình hai lớp

`config_layer_entries`: khoá chính `(org_id, layer, target_id, key)`; CHECK `layer in ('org', 'project')`; value JSONB có thể null, locked boolean, version số nguyên, updated_by, updated_at. RLS bật và ép, USING/WITH CHECK theo `hive.ctx_org()`.

Service chỉ ghi hàng tổ chức. Dự án vẫn lưu trong `projects.settings`. Với khoá ánh xạ chính sách, hàng tổ chức chỉ giữ khoá/phiên bản; `agent_policies` giữ giá trị duy nhất. Hàng đã gỡ giữ phiên bản để form cũ không ghi đè sau một chu kỳ đặt/gỡ.

`projects.settings.inheritedConfigKeys` là danh sách bốn khoá được phép kế thừa rõ ràng; adapter bỏ các khoá này khỏi lớp dự án. Nhờ vậy không xoá trường bắt buộc của cấu trúc cũ. Ghi giá trị khác qua API settings cũ gỡ dấu kế thừa đúng mục.

Team, run, instance, ceiling và cache desktop: ngoài phạm vi.
