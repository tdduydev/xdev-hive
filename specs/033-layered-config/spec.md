# Spec 033: Cấu hình tổ chức và dự án

Nhánh `ai/SPEC033`. Phạm vi chốt ngày 23/10/2026, thay bản bốn lớp chưa merge.

## Mục đích và giới hạn

Tổ chức đặt giá trị dùng chung; dự án đặt giá trị riêng và ghi đè, trừ khoá tổ chức đã khoá. Hub giữ metadata cấu hình, quyền và audit; web chỉ cấu hình. Việc thực thi thuộc desktop và worker. Không thêm chức năng ngoài Kho, Cấu hình, Duyệt và Quản trị.

Chỉ có hai lớp `org` và `project`, một luật ghi đè và cờ khoá. Không so độ chặt, không hạ giá trị khi đọc, không có `overCeiling`. Giá trị dự án có thể lớn hơn giá trị tổ chức khi chưa khoá. Khoá tổ chức tạm ngưng giá trị riêng đã lưu; mở khoá khôi phục giá trị đó.

## Các khoá được ánh xạ trong đợt này

| Khoá | Giá trị tổ chức | Giá trị dự án | Mặc định khi chưa đặt |
|---|---|---|---|
| `agent.permissionMode` | `agent_policies.defaultPermissionMode` | `settings.runPermissions.mode` | `workspace` |
| `limits.perRunUsd` | `agent_policies.limits.perRunUsd` | `settings.budget.perRunUsd` | không giới hạn |
| `merge.mode` | `config_layer_entries` | `settings.merge.mode` | `review` |
| `merge.requireCi` | `config_layer_entries` | `settings.merge.requireCi` | `false` |

Chính sách tổ chức vẫn là nguồn duy nhất cho các khoá đã ánh xạ. Cờ khoá và phiên bản nằm trong `config_layer_entries`. Không sao chép giá trị chính sách sang một nguồn ghi thứ hai. Các cài đặt chưa ánh xạ giữ nghiệp vụ hiện có.

## Tình huống nghiệm thu

1. Quản trị tổ chức mở “Cấu hình tổ chức”, đặt giá trị và bật/tắt khoá từng mục. Thành viên chỉ xem; quyền ghi là `policies.write` hoặc quản trị tổ chức. Mở quyền CLI mặc định `full` vẫn cần `policies.fullaccess`.
2. Trong cấu hình dự án, mỗi mục hiện giá trị hiệu lực và nhãn “Kế thừa tổ chức”, “Mặc định”, “Được ghi đè” hoặc “Bị tổ chức khoá”. Giá trị riêng bị tạm ngưng vẫn xem được.
3. Dự án đặt ngân sách 50 khi tổ chức đặt 20 và chưa khoá: hiệu lực là 50. Tổ chức khoá: hiệu lực là 20, giá trị riêng 50 giữ nguyên. Mở khoá: hiệu lực trở lại 50.
4. Dự án chọn “Dùng giá trị kế thừa”: khoá riêng không còn tham gia tính hiệu lực; các trường bắt buộc của settings cũ được giữ để tương thích. Thao tác này cũng bị chặn khi khoá.
5. Ghi qua `projects.updateSettings` phải kiểm khoá như API cấu hình mới. Bản vá không đổi khoá bị khoá vẫn được chấp nhận. Đường ghi chính sách tổ chức cập nhật giá trị chung và phiên bản, giữ cờ khoá; khoá chỉ hạn chế dự án, không cấm tổ chức đổi giá trị chung.
6. Giá trị, nguồn, chuỗi hai lớp và cờ khoá được trả từ hub. Người không xem được dự án nhận `PROJECT_NOT_FOUND`. Không trả secret. `configVersion` ổn định nếu dữ liệu không đổi và phân biệt tổ chức.
7. Form tổ chức gửi `expectedVersion`: sai phiên bản trả `CONFIG_VERSION_CONFLICT`. Khoá và ghi settings dùng cùng khoá transaction theo tổ chức. Mọi ghi thành công có audit trong cùng transaction.
8. Migration 0087 được sinh lại tại chỗ, CHECK chỉ nhận `org`/`project`, RLS bật và ép, policy có cả USING và WITH CHECK.
9. Những nơi đang đọc quyền CLI, ngân sách và cấu hình merge nhận giá trị hai lớp; không có phép lấy min theo tầng. Không thêm luồng thực thi mới.

## Ngoài phạm vi

- Lớp team: ngoài phạm vi.
- Lớp run: ngoài phạm vi.
- Lớp instance và quản trị toàn hệ thống: ngoài phạm vi.
- Ceiling, `overCeiling`, so độ chặt và hạ giá trị khi đọc: ngoài phạm vi.
- Cộng dồn/additive: ngoài phạm vi; bốn khoá hiện tại đều cần ghi đè. Allowlist skill/MCP chưa được đưa vào registry.
- Cache desktop, lưu ngoại tuyến, TTL và xử lý ảnh chụp cũ: ngoài phạm vi.
- Lịch sử cấu hình có giao diện riêng: ngoài phạm vi; dùng audit hiện có.
- Chuyển dự án giữa đội và xem trước ảnh hưởng: ngoài phạm vi.
- Đưa sandbox, skill, MCP, plugin và secret vào registry: ngoài phạm vi.
- Sửa delivery, sdlc, tenancy và `worker/internal/config`: ngoài phạm vi.

## Kiểm tra

Unit test engine, adapter và contracts; DB test quyền, khoá đường ghi cũ/mới, phiên bản, audit, RLS và ghi đồng thời; Playwright màn tổ chức và dự án. DB test cần Docker. Không chạy full `pnpm ci:local`.
