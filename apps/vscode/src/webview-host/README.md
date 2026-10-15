# Webview host

`createPanel(ctx, screen)` mở panel; `registerView(ctx, viewId, screen)` nối một Webview View đã khai báo trong
manifest. Cả hai giới hạn tài nguyên ở `dist/webview`, gắn cầu nối trước khi nạp HTML và hủy yêu cầu khi đóng.
Không dùng host này cho `artifact-frame` (task T017 có CSP riêng).

Mỗi màn thêm đường dẫn **chính xác**, ví dụ `/rpc/sdlc/items/list`, vào `allowlist/<màn>.ts`. Danh sách rỗng mặc định
từ chối tất cả. Không lấy allowlist, URL hub, header hay màn từ thông điệp của webview. Component của màn đăng ký
ở bảng `screens` trong `webview/main.tsx`; khung hiện tại chỉ có màn rỗng.

Phần hub đăng ký `provideRpcTransport((request, signal) => ...)` từ host; callback gắn thông tin xác thực ở host và
trả `{ status, contentType, body }`. `request` chỉ có `{ path, method, body }`; `path` gồm `/rpc/...` và query của
oRPC, `method` là GET hoặc POST. Truyền `signal` xuống lời gọi mạng. Giữ disposable trả về trong subscriptions.
Khi chưa đăng ký transport, thủ tục hợp lệ trả 503; không cần sửa khung host khi task T010 nối client.

Webview dùng `hub` có kiểu từ `@/bridge.ts`. `bridge.writeClipboard(text)`, `bridge.download(text)` và
`bridge.openExternal(url)` đi qua host. Tải tệp UTF-8 chỉ ghi sau khi người dùng chọn đích bằng hộp thoại VS Code;
hủy hộp thoại trả `false`. Liên kết chỉ cho HTTPS hoặc cùng origin với hub HTTP đã cấu hình.
`bridge.getState<T>()` / `setState(state)` dùng bộ nhớ trạng thái của VS Code thay cho `sessionStorage`.

Mỗi thông điệp tối đa 1 MiB, tối đa 32 yêu cầu đồng thời và timeout phía webview 120 giây. Đóng màn hoặc abort
sẽ gửi hủy tới host. Không gửi token vào HTML/state; lỗi transport dùng thông báo cố định, body phản hồi được che
token Hive trước khi trả về webview.
