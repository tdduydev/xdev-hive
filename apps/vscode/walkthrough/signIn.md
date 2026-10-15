# 2. Đăng nhập

[Đăng nhập xDev Hive](command:xdevHive.signIn)

Trình duyệt mở trang đăng nhập trên hub đã cấu hình. Đăng nhập, chọn tổ chức và quay lại editor. Chỉ chấp thuận hub mà bạn tin cậy; không dán token vào settings hoặc mã nguồn.

CLI dùng keychain hệ điều hành; extension có bản lưu trong SecretStorage của VS Code, và vẫn đăng nhập được khi chưa có CLI. Phiên hết hạn thì đăng nhập lại. Đăng xuất editor chỉ ngắt phiên editor; thu hồi token trên hub hoặc đăng xuất chung nếu cần ngắt cả CLI/desktop.

Cần hub cho bước này. Bỏ qua nếu chỉ dùng tiện ích tại máy. Quyền xem việc, duyệt và chạy agent do hub quyết định.

## English

Sign in through your configured hub in the browser, select your organization and return to the editor. Credentials use the OS keychain and VS Code SecretStorage. Local tools do not require this step. Editor sign-out does not revoke shared CLI/desktop access.
