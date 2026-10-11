# Thiết kế màn (Claude Design)

Bản xuất các artboard của canvas "xDev Hive Screens" trên Claude Design, dùng làm tham chiếu khi làm màn web.

| File | Màn | Route |
|---|---|---|
| `Main.dc.html` | Đăng nhập | `/login` |
| `Sidebar.dc.html` | Thanh điều hướng | dùng chung |
| `Tasks.dc.html` | Bảng việc | `/tasks`, `/projects/$key` |
| `RunDetail.dc.html` | Chi tiết run | `/runs/$id` |
| `MergeQueue.dc.html` | Hàng merge | `/projects/$key/merge-queue` |
| `Notifications.dc.html` | Thông báo | `/notifications` |
| `Costs.dc.html` | Chi phí và token | `/admin/costs` |
| `Machines.dc.html` | Máy | `/machines` |

Cách đọc: phần HTML có style inline theo token trong `../tokens.json`; khối `<script data-dc-script>` chứa dữ liệu mẫu
và trạng thái tương tác. Số liệu, tên máy, mã việc đều là dữ liệu mẫu. Code thật dùng thành phần trong
`apps/web/src/components/ui`, không chép style inline.

Ảnh logo trong file trỏ tới `/_blob/...` của canvas nên không hiện khi mở file trực tiếp; logo thật nằm ở
`../assets/logos/`.
