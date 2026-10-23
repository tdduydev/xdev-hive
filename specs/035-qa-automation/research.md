# Research: AI SDLC cho tester (QA Automation)

## R1. Chạy bộ test: run agent hay job tất định

- **Decision**: Đợt đầu dùng run `sdlc` có agent (bước `test-run`). Job `qa_suite` không qua agent làm sau 027.
- **Rationale**: Thêm loại run cần sửa engine, `worker-protocol.ts` và runner của worker, đều đang có agent khác sửa
  (027). Run `sdlc` đã có chọn máy theo nhãn, MCP, token run, kết thúc qua `onSdlcRunFinished`.
- **Alternatives**: Job tất định gửi lệnh shell tới worker: rẻ hơn, không tốn token, nhưng chạm kênh worker. Nhập kết
  quả từ CI (delivery): ngoài phạm vi, module `delivery` đang bị khoá.

## R2. Định dạng báo cáo test

- **Decision**: Playwright JSON reporter (`--reporter=json`) và JUnit XML. Một parser Go cho cả hai, ra `Summary` chung.
- **Rationale**: Playwright là ưu tiên của chủ dự án. JUnit XML là định dạng chung của pytest (`--junitxml`), Maven
  Surefire, Gradle, Jest (`jest-junit`), Go (`go-junit-report`), Playwright (`--reporter=junit`).
- **Chi tiết**:
  - Playwright JSON: `suites[].specs[].tests[].results[]`, trạng thái test `expected|unexpected|flaky|skipped`; khoá test
    là `file › tiêu đề` (nối title của suite lồng nhau); `retries` = số kết quả trừ 1.
  - JUnit XML: gốc `testsuites` hoặc `testsuite`; `testcase` có `failure`/`error` là fail, `skipped` là bỏ qua;
    Surefire `flakyFailure`/`flakyError` là chập chờn, `rerunFailure` là fail sau thử lại. Khoá là `classname.name`.
- **Alternatives**: Parser ở hub (TS): hub phải nhận file gốc, trái 027 Q3.

## R3. Đưa kết quả lên hub

- **Decision**: `sdlc_report` loại mới `test-results`.
- **Rationale**: Không phải sửa module `mcp` (tool đăng ký trong `sdlc/mcp-tools.ts`). Đã có kiểm run token, bước đang
  chạy, ghi đè khi gọi lại.
- **Alternatives**: MCP tool riêng `qa_report`: tách bạch hơn nhưng thêm một tool nữa cho agent nhớ.

## R4. Bảng: module mới hay trong `sdlc`

- **Decision**: Trong `sdlc` (`schema.ts`).
- **Rationale**: TC sinh từ tài liệu của hạng mục, lỗi tạo hạng mục, chốt ở `onSdlcRunFinished`; tách module sẽ cần xuất
  nhiều hàm nội bộ qua `index.ts` và vòng phụ thuộc hai chiều.

## R5. Chập chờn

- **Decision**: (a) pass sau thử lại trong một lần chạy; (b) ≥ 2 lần đổi pass/fail trong 10 kết quả gần nhất (bỏ
  `skipped`). Cách ly thủ công.
- **Rationale**: Cách phổ biến (Google "flaky" theo lần đổi, Playwright `flaky`). Tự cách ly có rủi ro giấu lỗi thật
  (câu hỏi mở cho chủ dự án).

## R6. Cron

- **Decision**: Hàm thuần `nextCronFire(expr, timeZone, after)` trong contracts, dùng `Intl.DateTimeFormat`.
- **Rationale**: Hub chưa có thư viện cron; pg-boss có cron nhưng theo hàng đợi, không theo bản ghi người dùng tạo.
- **Alternatives**: `cron-parser`/`croner`: thêm phụ thuộc cho một hàm nhỏ.

## R7. Vai trò tester

- **Decision**: Định nghĩa trong spec, cài sau 034. Tạm thời cổng dùng `team-admin` (QA lead) và `team-member` (tester).
- **Rationale**: 034 đang đổi tenancy; thêm `teamRole` bây giờ sẽ xung đột.

## R8. Hạng mục bugfix tự tạo

- **Decision**: Tự tạo khi chốt lần chạy, chủ là chủ hạng mục QA, trong savepoint.
- **Rationale**: Brief của chủ dự án: test hỏng thật "tạo hoặc cập nhật hạng mục bugfix". Lỗi tạo (dự án không cho
  chế độ `bugfix`) không làm hỏng lần chạy.
