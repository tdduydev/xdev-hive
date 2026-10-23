# Kế hoạch 035: Tự động hoá QA

Phạm vi theo [spec.md](spec.md), chốt 23/10/2026.

## Kiến trúc

Preset `qa-automation` dùng bảy pha chuẩn: phạm vi, kế hoạch, TC, chia việc, viết script tại máy, duyệt QA, kết luận.
Không thêm vai trò; cổng người duyệt dùng team-admin hiện có.

1. Contracts định nghĩa TC, metadata strict, parser bảng và route đọc/miễn.
2. `sdlc_qa_cases` trong module sdlc lưu TC đã duyệt và quyết định miễn; FK kép item/org, ENABLE và FORCE RLS.
3. Baseline tài liệu `test-cases` upsert TC, retire dòng bị bỏ, reset miễn khi TC đổi. Bảng sai rollback baseline.
4. Khi giao `test-run`, hub chụp fingerprint TC vào `sdlc_steps.result.qaBaseline`; hợp nhãn dự án và bước.
5. Worker/agent chạy runner tại máy, dùng `hive test-summary`, gửi metadata bằng `sdlc_report` sẵn có.
6. Metadata lưu trong `sdlc_steps.result['test-results']`; không cần bảng kết quả hoặc hệ thống thực thi mới.
7. `qa-tests` nhận checklist qua `ruleContext`. `phaseReady`, `advance` và `approvePhase` giữ cùng điều kiện QA.
8. `QaPanel` ở package sdlc-ui dùng chung web/desktop, từ điển vi/en, chỉ xem và miễn; không thực thi test.

## File chính

- Contracts: `packages/contracts/src/qa.ts`, `qa.test.ts`, `sdlc.ts`, `workflows.ts`, `sdlc-presets/qa-automation.ts`.
- Hub: `sdlc/{qa,qa-gate,qa-routes}.ts`; nối schema, phases, steps, mcp-tools, router và review-hooks.
- Luật duyệt: `knowledge/review-rules.ts`, `knowledge/reviews.ts` qua điểm nối sẵn có; không sửa module mcp.
- Worker: `internal/testreport/summary.go`, `cmd/hive/testsummary.go`; CLI không cần đăng nhập hay mạng để tóm tắt.
- UI: `packages/sdlc-ui/src/qa-panel.tsx`, `item-detail.tsx`, `text.ts`; Playwright `apps/web/e2e/qa.spec.ts`.

## Tính nhất quán

Baseline, miễn và tiếp nhận metadata khoá hạng mục. Fingerprint dùng định nghĩa TC chuẩn hoá cùng revision, sắp theo mã,
không phụ thuộc thứ tự key JSONB, quyết định miễn hay thứ tự dòng. Bằng chứng chỉ từ bước mới nhất thành công.
Miễn có hiệu lực cho TC hiện tại và bị xoá khi TC đổi/retire; lý do vẫn còn audit.
Route xác thực org dùng middleware/withTenant hiện có và kiểm quyền đội mỗi lần gọi.

## Kiểm tra

Unit: bảng TC, schema strict, parser Playwright/JUnit, gộp nhiều test, cổng fail-closed và fingerprint.
DB: đồng bộ baseline, rollback bảng sai, ghi lại báo cáo, quyền miễn, tenant và kết quả cũ.
UI: metadata, FR/AC, lý do bắt buộc, miễn và ẩn nút khi thiếu quyền; không có nút thực thi ở web.
Chạy checks liên quan theo quy tắc người dùng; không chạy full `pnpm ci:local`. DB cần Docker và chạy CI khi máy thiếu Docker.
Migration sinh cuối, giữ số tại worktree; người điều phối đánh số lại khi merge.

## Ngoài phạm vi

- Cách ly test chập chờn: ngoài phạm vi.
- Lịch chạy hồi quy: ngoài phạm vi.
- Vai trò Tester: việc làm sau, không thêm enum/quyền/hồ sơ mới trong bản này.
- Vòng tự tạo lỗi và dashboard xu hướng: ngoài phạm vi.
