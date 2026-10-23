# Công việc 035: Tự động hoá QA

Danh sách thay thế kế hoạch cũ theo phạm vi chốt 23/10/2026; không chia agent hay mở luồng phụ thuộc spec khác.

- [x] T001 Thu gọn đặc tả, kế hoạch và hợp đồng phụ theo ba phần TC, metadata tại máy và cổng QA.
- [x] T002 Contracts strict cho TC/kết quả, parser bảng liên kết FR/AC, test đơn vị.
- [x] T003 Preset QA dùng bước `test-run`, nhãn máy và luật `qa-cases`/`qa-tests`; không thêm vai trò.
- [x] T004 Đồng bộ baseline TC vào bảng có tenant, giữ id, retire và thu hồi miễn khi sửa; viết DB test.
- [x] T005 Gộp nhãn và chụp fingerprint khi giao bước; nhận metadata qua sdlc_report; thiếu metadata thì bước lỗi.
- [x] T006 Parser Playwright/JUnit và CLI `hive test-summary`, chỉ xuất metadata, test chạy được trên Windows.
- [x] T007 Luật QA và điều kiện chuyển verification dùng lần mới nhất, fail-closed; test đơn vị và DB.
- [x] T008 Route đọc/miễn có kiểm quyền hiện có, lý do và audit; không thêm API thực thi ở hub/web.
- [x] T009 Panel metadata/cổng QA dùng chung web và desktop, từ điển vi/en; Playwright liên quan.
- [x] T010 Sinh migration cuối cùng, bật ENABLE/FORCE RLS, kiểm số và xuất OpenAPI.
- [x] T011 Chạy Biome, typecheck, deps, unit, Go vet đa nền tảng, test Go liên quan và Playwright; DB thực tế chạy được, kết quả ghi ở tóm tắt.
- [x] T012 Commit tại máy và ghi SUMMARY-SPEC035.md với phần còn lại/rủi ro.

## Việc làm sau

- Cách ly test chập chờn: ngoài phạm vi.
- Lịch chạy hồi quy: ngoài phạm vi.
- Vai trò Tester riêng: việc làm sau; bản này dùng quyền của đội đang có.
