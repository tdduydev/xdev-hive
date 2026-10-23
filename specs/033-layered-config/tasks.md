# Công việc: Cấu hình hai lớp

- [x] T001 Rút contract và registry về tổ chức/dự án, bỏ team, ceiling, `overCeiling`.
- [x] T002 Engine ghi đè và khoá, chuỗi nguồn, phiên bản nội dung; unit test không hạ giá trị.
- [x] T003 Adapter chính sách/settings và thao tác quay về kế thừa; giữ dữ liệu riêng đang bị khoá.
- [x] T004 Service/API tổ chức và dự án, quyền, phiên bản, transaction và audit.
- [x] T005 Ép khoá đường ghi project settings; đồng bộ đường ghi org policy cho khoá ánh xạ, không tạo nguồn giá trị trùng.
- [x] T006 Dùng giá trị hiệu lực ở các nơi đọc quyền CLI, ngân sách và merge đang có.
- [x] T007 Trang cấu hình tổ chức với công tắc khoá, menu và liên kết.
- [x] T008 Tab cấu hình dự án hiển thị kế thừa, ghi đè, khoá, giá trị riêng tạm ngưng; thao tác trở về kế thừa.
- [x] T009 Viết DB test quyền, phiên bản, khoá cũ/mới, audit và RLS; viết unit/contract/Playwright liên quan.
- [x] T010 Sinh lại migration 0088 và snapshot, thêm FORCE RLS; sinh OpenAPI.
- [x] T011 Biome, typecheck, deps, vitest và Playwright liên quan; ghi kết quả trong tóm tắt.
- [x] T012 Commit tại máy và ghi tóm tắt điều phối; không push, PR hoặc deploy.

## Phần bị cắt

- T020 Lớp instance: ngoài phạm vi.
- T021 Lớp run và bổ sung ảnh chụp vào job: ngoài phạm vi.
- T022 Cache desktop, TTL và cấu hình ngoại tuyến: ngoài phạm vi.
- T024 Lớp team và trang cấu hình đội: ngoài phạm vi.
- T026 Giao diện lịch sử cấu hình riêng: ngoài phạm vi.
- T027 Chuyển dự án giữa đội: ngoài phạm vi.
- T028 Gộp sandbox, skill-pack và MCP vào registry: ngoài phạm vi.
- T029 So độ chặt, ceiling, `overCeiling`, hạ giá trị khi đọc: ngoài phạm vi.
- T030 Cấu hình SDLC, delivery và tenancy: ngoài phạm vi.
- T031 Additive: ngoài phạm vi khi chưa có allowlist cần gộp.
