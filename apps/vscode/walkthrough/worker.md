# 4. Cài CLI và worker

[Cài hive CLI và worker](command:xdevHive.worker.install)

Binary được tải khi cần và kiểm checksum cùng chữ ký. Chỉ cho phép chạy chương trình trong workspace bạn tin cậy. Nếu dịch vụ phát hành không truy cập được, hỏi quản trị viên về binary tương thích; không tải từ nguồn lạ.

Cài binary không đăng ký máy. Để nhận việc Hive, đăng ký máy riêng với hub theo hướng dẫn của quản trị viên rồi [khởi động worker](command:xdevHive.worker.start). Mặc định `xdevHive.worker.autoStart` tắt; chỉ bật khi muốn tự nhận việc mỗi lần mở editor.

Nếu desktop đã giữ worker thì extension dùng chung tiến trình đó. Với SSH/WSL, cài và đăng ký máy remote có mã nguồn. Dev Container và bản web không chạy worker. Worker do VS Code giữ dừng khi cửa sổ sở hữu đóng.

CLI cũng phục vụ các tiện ích tại máy, không bắt buộc có hub cho phần đó. Worker nhận run và các tính năng cộng tác cần hub, đăng nhập và quyền của tổ chức.

## English

Install the CLI and worker, then register this machine with your hub only if it should run Hive jobs. Downloads are checksum/signature verified. Auto-start is off by default. Desktop and VS Code share a worker; SSH/WSL require separate remote registration. Local CLI tools do not require a hub. Dev Containers and web editors do not run workers.
