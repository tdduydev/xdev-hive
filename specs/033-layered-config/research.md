# Quyết định triển khai

- Chốt 23/10/2026: tổ chức và dự án, ghi đè và khoá. Bản bốn lớp chưa merge nên sửa migration 0087 tại chỗ.
- Giữ chính sách và settings cũ làm nguồn để mọi đường ghi cùng có hiệu lực; không sao chép giá trị chính sách.
- Bốn khoá thực tế: quyền CLI, ngân sách mỗi run, chế độ merge, yêu cầu CI. Chưa có allowlist cần gộp nên không giữ additive.
- Khoá chỉ ngăn dự án sửa; quản trị tổ chức có thể đổi giá trị chung mà vẫn giữ khoá.
- Giữ giá trị riêng khi bị khoá để mở khoá khôi phục được. Dùng dấu kế thừa cho trường bắt buộc của settings cũ.
- Tiêm guard và hàm đọc cấu hình qua điểm ghép app/main nhằm giữ ranh giới module, tránh vòng import.

Team, run, instance: ngoài phạm vi. Ceiling/`overCeiling`: ngoài phạm vi. Cache desktop: ngoài phạm vi. Sửa delivery/SDLC/tenancy/worker: ngoài phạm vi.
