# Contract: `hive test-summary`

```text
hive test-summary <file> [--format auto|playwright|junit] [--runner <tên>] [--suite <tên>] [--environment <tên>]
                         [--max-cases 5000] [--max-message 500]
```

- Đọc file báo cáo tại máy, không gửi gì lên hub.
- `--format auto` (mặc định): `.xml` hoặc nội dung bắt đầu bằng `<` là JUnit, còn lại là Playwright JSON.
- In ra stdout một JSON đúng `qaTestReport` (xem [mcp-report.md](mcp-report.md)); agent chuyển nguyên văn vào
  `sdlc_report`.
- Che thông điệp lỗi trước khi in: token dạng `Bearer …`, `password=…`, `token=…`, chuỗi `ghp_`/`glpat-`/`sk-`, URL có
  user:pass. Cắt `--max-message` ký tự. Khi số test vượt `--max-cases`: giữ `failed`, `flaky` trước, `truncated: true`,
  `totals` vẫn là số thật.
- Mã thoát: 0 khi đọc được (kể cả khi có test fail), 2 khi sai tham số, 1 khi không đọc được file.
- JUnit nhiều file: truyền nhiều đường dẫn, gộp lại (`hive test-summary a.xml b.xml`).
