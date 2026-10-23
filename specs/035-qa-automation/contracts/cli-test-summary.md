# hive test-summary

`hive test-summary <file> [--format playwright|junit] [--commit SHA] [--max-cases N]`

Tự nhận dạng JSON/XML nếu không có `--format`; không gọi mạng, không cần token.
File tối đa 32 MiB, `N` từ 1 đến 5.000. Mã TC lấy từ tên test/class/suite; một test nhiều mã TC khác nhau bị từ chối.
Nhiều test cùng TC gộp theo failed > flaky > skipped > passed. Cắt ưu tiên giữ trạng thái xấu.
Không có mã TC vẫn tính tổng runner nhưng không tạo bằng chứng cho TC bắt buộc.

Mã thoát 0 khi đọc hợp lệ (kể cả test fail), 2 khi dữ liệu/tham số sai, 1 khi không ghi được metadata.
Chỉ stdout JSON metadata theo [mcp-report.md](mcp-report.md); lỗi tiếng Việt ghi stderr, không chép nội dung reporter.
