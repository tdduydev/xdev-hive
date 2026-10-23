# sdlc_report: test-results

Chỉ run đang hoạt động của bước `test-run` được gửi. `data` theo `qaTestReport`:

```json
{
  "runner": "playwright",
  "totals": { "total": 1, "passed": 1, "failed": 0, "skipped": 0, "flaky": 0 },
  "durationMs": 100,
  "cases": [{ "code": "TC-001", "status": "passed", "retries": 0, "durationMs": 100 }],
  "truncated": false
}
```

`commit` tuỳ chọn là SHA hex đầy đủ 40/64 ký tự. Mã TC duy nhất, tối đa 5.000, không vượt tổng runner.
Tổng từng trạng thái phải khớp tổng số test. Dòng TC được gộp theo kết quả xấu nhất nên có thể ít hơn tổng runner.
Trường lạ (log, code, tên test, lỗi, URL, attachment…) bị từ chối cả ở cấp con.
Hub đối chiếu TC đã duyệt và fingerprint đã chụp lúc giao bước. Gửi lại ghi đè cùng bước.
