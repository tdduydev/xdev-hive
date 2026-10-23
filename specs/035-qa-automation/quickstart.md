# Quickstart: AI SDLC cho tester

1. Máy test: gắn nhãn `browser` và `qa-env` cho worker (`hive labels add browser qa-env`, hoặc trong cài đặt máy).
   Cài Playwright và trình duyệt trong repo test. Đặt biến môi trường test (URL, tài khoản) trong kho bí mật tại máy
   (031) theo dự án.
2. Dự án: bật chế độ `qa-automation` cho dự án test (Cài đặt dự án → Chế độ). Dự án sản phẩm cần bật `bugfix` để vòng
   lỗi tạo được hạng mục.
3. QA lead tạo hạng mục với chế độ "QA Automation", ý tưởng là phạm vi cần test. Agent viết `scope.md`, rồi
   `test-plan.md` (cổng QA lead), rồi `test-cases.md` (cổng tester).
4. Khi `test-cases.md` được duyệt, hub tạo TC (`TC-001`…). Xem ở `/projects/<key>/qa`.
5. Pha breakdown chia việc viết script theo TC; pha implement viết script (PR vào repo test).
6. Pha verification: bước `test-run` chạy trên máy có nhãn. Agent chạy:
   ```bash
   npx playwright test --reporter=json > .hive/test-report.json
   hive test-summary .hive/test-report.json --suite regression --environment staging
   ```
   rồi gọi `sdlc_report` loại `test-results`.
7. Kiểm: màn Kiểm thử hiện lần chạy, tỉ lệ pass, TC fail có lỗi mở và hạng mục bugfix mới ở dự án sản phẩm; TC chập
   chờn không mở lỗi.
8. Pha release: `regression.md` liệt kê TC thuộc bộ hồi quy; khi duyệt, các TC đó có cờ hồi quy.

Thử parser không cần hub:

```bash
cd worker && go run ./cmd/hive test-summary internal/testreport/testdata/playwright.json
```
