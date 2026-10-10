# Gói agent và quota

Mỗi **gói** (profile) là một tài khoản agent đã đăng nhập trên một máy, ví dụ một tài khoản Claude hay ChatGPT (Codex). Runner trên máy chọn gói cho từng run và xoay vòng khi một gói hết quota. Bản tiếng Anh: [../en/agents-and-quota.md](../en/agents-and-quota.md).

Phần lớn việc ở đây làm trong **app desktop** › *Gói agent*. Trên web, **Máy & agent** cho cả team xem máy, gói và quota.

## Thêm và đăng nhập một gói

1. App › **Gói agent** › *Thêm gói*.
2. Ở *Tài khoản đăng nhập*, chọn loại: *Tài khoản Claude*, *Tài khoản ChatGPT (Codex)*, *Tài khoản Google (Antigravity)*, *Tài khoản Google (Gemini CLI)*, *Tài khoản Mistral Vibe*, *OpenCode (provider / model)*, *Tài khoản Kilo Code*, *Tài khoản GitHub Copilot*.
3. Đặt *Tên hiển thị* (tuỳ chọn), chọn *Cách đăng nhập* (ví dụ *Gói Claude (Pro, Max, Team)*, *SSO của công ty*, *Trình duyệt trên máy này*, *Mã thiết bị (đăng nhập ở máy khác)*).
4. Bấm *Thêm và đăng nhập*, làm theo terminal hay trình duyệt mở ra.
5. Dòng gói chuyển *Sẵn sàng*. Nếu hiện *Chưa có CLI*, bấm *Cài CLI*; nếu *Chưa đăng nhập*, bấm *Đăng nhập*.

Mỗi gói có thư mục cấu hình riêng nên hai tài khoản cùng loại không lẫn nhau. Hive không lưu mật khẩu hay API key của gói lên hub.

> *Loại agent tự đặt* (trong cùng hộp *Thêm gói*) tạo profile từ lệnh tuỳ ý; chỉ dùng khi bạn biết CLI đó chạy headless thế nào.

## Thao tác trên một gói

| Nút | Làm gì |
|---|---|
| *Bật* / *Tắt* | Gói tắt thì runner không giao run cho nó. |
| *Sửa* | *Lệnh*, *Tham số*, *Biến môi trường*, *Vai trò* (lập kế hoạch, làm task, review), *Ưu tiên*, *Song song tối đa*, *Nghỉ mặc định (phút)*, *Giới hạn mỗi run (phút)*, *Chỉ đọc Hive*, *Chạy trong container (Docker)*. Bấm *Lưu profile*. |
| *Kiểm tra CLI* | Kiểm lại CLI và trạng thái đăng nhập. |
| *Mở CLI* / *Mở CLI trong <service>* | Mở terminal chạy CLI tương tác bằng tài khoản của gói (không tính là run). |
| *Xoá* | Xoá gói khỏi máy. |

## Quota

Bảng gói có cột *Phiên 5 giờ*, *Tuần*, *Chi phí*.

- *Ngưỡng dừng*: *Dừng khi phiên đạt (%)*, *Dừng khi tuần đạt (%)*. Gói chạm ngưỡng chuyển *Chạm ngưỡng* và không nhận run mới.
- *Đọc lại quota*: đọc lại ngay (mặc định app tự đọc định kỳ).
- Gói *Đang nghỉ* (vừa hết quota): hiện giờ reset; *Dùng tiếp* nếu bạn biết quota đã có lại.
- *Đặt lại bộ đếm*: đặt lại số lần chạm giới hạn, số run.
- *Token và cache*: token vào mới, ghi/đọc cache, ra, % từ cache theo 24 giờ / 7 ngày / 30 ngày.

Một số CLI không báo quota; khi đó cột hiện *Chưa biết* kèm lý do.

### Cách runner chọn gói

Gói được ghim (nếu có) → bỏ gói tắt, đang bận, đang nghỉ, sai vai trò → review dùng hãng khác người làm → gói có kỳ quota reset sớm hơn → gói còn nhiều quota hơn → số ưu tiên nhỏ hơn → gói lâu chưa dùng.

Hết quota giữa chừng: phần làm dở được commit `wip`, lần sau chạy tiếp trên cùng branch bằng gói khác.

## Nhận việc từ hub

1. App › **Gói agent** › thẻ *Nhận việc trên máy này*: bật, đặt *Tối đa cùng lúc*. Lưu ngay khi đổi.
2. *Cài đặt runner*: *Được nhận run từ hub*, *Agent chạy song song*, *Thư mục worktree*, *Tự cập nhật khi không có run*. Bấm *Lưu*.

Admin hub và chủ máy cũng bật/tắt được từ web: **Máy & agent** › *Bản đồ agent* › máy › *Nhận việc từ hub*, *Bật/tắt và ưu tiên gói*.

## Xem cả team trên web

**Máy & agent** có các tab:

| Tab | Ai thấy | Nội dung |
|---|---|---|
| *Bản đồ agent* | Người xem được service | Máy → gói → run đang chạy; CPU, RAM, ổ đĩa; chọn gói rồi *Prompt cho agent*. Mỗi máy có *Tool* (cho phép tool từ hub) và *Worktree*. |
| *Quota* | Người xem được service | *Quota cả nhóm*: phiên 5 giờ, tuần, giờ reset của mọi gói. |
| *Đội máy*, *Hàng đợi*, *Chi phí* | Admin hub | Heartbeat của máy, run chờ máy và lý do, chi phí ước tính theo giá API. |

## Worktree

Mỗi task chạy trong worktree riêng trên branch `ai/<task>`, không đụng checkout chính của bạn.

- App › **Worktree** (hoặc web › *Bản đồ agent* › máy › *Worktree*): dung lượng, *Trên remote* (*Đã push*), *Chưa commit*, *Đã vào main*.
- *Xoá* / *Xoá đã chọn (n)*: xoá thư mục, branch vẫn giữ.
- *Tự dọn worktree*: mặc định bật; chỉ dọn worktree không có run, không còn thay đổi chưa commit, và HEAD đã push. Đặt *Số ngày giữ task done chưa vào main* và *Ngưỡng ổ trống (GB)*, bấm *Lưu tự dọn*.

> Cảnh báo: xoá worktree còn thay đổi chưa commit sẽ mất các file đó. App yêu cầu tick xác nhận trước.

## Dừng mọi agent

Khi cần dừng gấp (ví dụ agent làm sai hàng loạt): **Quản trị** › *Tổng quan vận hành* › *Dừng mọi agent* cho một service hoặc *cả hub*. Hub huỷ yêu cầu run đang chờ, báo máy dừng run đang chạy, và từ chối run mới cho tới khi bấm *Cho agent chạy lại*. Dừng cả hub cần admin hub. Người có quyền giao/dừng run của một service (không phải admin hub) dùng nút cùng tên trên trang *Tổng quan* (⌘K › *Tổng quan*).
