# 1. Nhập URL hub

Hub là máy chủ xDev Hive của tổ chức. Hỏi quản trị viên URL và quyền truy cập; extension không tạo hub khi cài.

[Nhập URL hub](command:xdevHive.setHubUrl)

Ví dụ: `https://hive.example.com`. Đặt `xdevHive.hubUrl` trong cài đặt người dùng, không trong workspace. Dùng HTTPS khi kết nối máy khác.

Chưa có hub? Để trống URL. Các tiện ích tại máy (tối ưu token, memory, context pack) không cần hub khi đã được tích hợp, nhưng cần CLI tương thích. Model của editor có thể cần tài khoản riêng. Việc, duyệt, run, tri thức dùng chung và Hive MCP cần hub.

## English

Enter the hub URL supplied by your organization. Leave it empty if you only need local tools. Collaboration and Hive MCP require a hub; local tools require a compatible CLI. This step does not create a hub or account.
