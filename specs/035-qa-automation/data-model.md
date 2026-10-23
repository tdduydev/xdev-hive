# Dữ liệu QA

## hive.sdlc_qa_cases

`id`, `org_id`, `item_id`, `code`, `definition` (JSONB TC đã kiểm schema), `revision`, `retired`,
`waived_by`, `waiver_reason`, `waived_at`, `updated_at`.

- Duy nhất `(item_id, code)`. FK kép `(item_id, org_id)` đến hạng mục; cascade khi xoá hạng mục.
- ENABLE và FORCE RLS, policy theo `hive.ctx_org()`. Kiểm quyền đội ở service.
- Các trường miễn cùng có giá trị hoặc cùng null. Thay TC xoá miễn; audit lưu lịch sử quyết định.

## Metadata kết quả

Dùng `sdlc_steps.result` hiện có: `qaBaseline` là SHA-256 của bộ TC hiện tại; `test-results` là JSON strict.
Run id, thời điểm, trạng thái lấy từ bước trên hub, không tin dữ liệu client tự khai.
Không tạo bảng log, defect, quarantine hay schedule. Các lần chạy cũ giữ trong lịch sử bước.

## Ngoài phạm vi

Cách ly test chập chờn: ngoài phạm vi.
Lịch chạy hồi quy: ngoài phạm vi.
