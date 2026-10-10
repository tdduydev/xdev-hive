# Quản trị hub

Cho admin hub và người quản lý service. Mục **Quản trị** trên web chỉ admin hub thấy; **Cài đặt service** hiện cho người có quyền cài đặt hoặc quản lý thành viên của service. Bản tiếng Anh: [../en/admin.md](../en/admin.md).

## Các tab của Quản trị

| Nhóm | Tab | Dùng để |
|---|---|---|
| Vận hành | *Tổng quan vận hành* | Sức khoẻ hub, hàng đợi, chi phí (24 giờ / 7 ngày / 30 ngày), *Dừng mọi agent*. |
| | *Ngân sách* | *Trần chi tiêu* theo service, theo người hay cả hub, theo ngày hoặc tháng, bằng USD ước tính hoặc số run. |
| | *Cảnh báo* | Sự cố đang mở và luật cảnh báo (run lỗi liên tiếp, máy offline, webhook lỗi, quota gần hết…); bấm *Đã biết*. |
| Truy cập | *Người dùng & quyền* | Tài khoản, vai trò hub, quyền theo service. |
| | *Vai trò & quyền* | Ma trận quyền của từng vai ở một service. |
| | *Sơ đồ tổ chức* | Ai giữ vai nào ở từng hệ thống và service. |
| | *Chính sách* | Chính sách của hub cho mọi dự án: chính sách agent, trần chốt SDLC, luật tự duyệt, giới hạn thời gian run, *Hàng chờ merge*, *Service nghỉ*. |
| | *Tool* | Danh mục tool (MCP, hook, plugin, CLI) với phiên bản ghim. |
| Hệ thống | *Nhật ký* | Mọi thao tác thay đổi dữ liệu, của người và của agent (agent nào, thay ai, run nào). |
| | *Thông báo & webhook* | Gửi tin vào Teams hoặc Slack. |
| | *Phiên bản app* | Rollout bản app desktop cho các máy. |
| | *Hub* | Phiên bản hub, database, tệp tài liệu, backup. |

## Người dùng và quyền

### Mời người

1. **Quản trị** › *Người dùng & quyền* › *Mời người dùng*.
2. Tab *Link mời*: chọn *Vai trò hub*, *Hiệu lực (ngày)*, bấm *Tạo link*, gửi link cho người đó. Hoặc tab *Tạo tài khoản*.
3. Link đã tạo nằm ở danh sách *Link mời* (*Còn hiệu lực*, *Đã dùng*, *Hết hạn*); *Thu hồi* nếu gửi nhầm.

### Cấp quyền theo service

1. Ở danh sách người dùng, bấm vào một người (*Sửa quyền của <tên>*).
2. Mỗi service (và *Chung*) chọn một vai: *Người xem*, *Thành viên*, *QA*, *Reviewer*, *Quản lý service*, hoặc *Tuỳ chỉnh* rồi tick từng quyền ở *Quyền chi tiết*.
3. Service không được cấp thì người đó không thấy gì của service đó, kể cả qua agent và MCP.

Quản lý service tự cấp quyền trong service của mình ở **Cài đặt service** › *Thành viên*.

### Việc khác

- Chọn nhiều người: *Đổi vai trò hub*, *Cấp admin hub*, *Bỏ admin hub*, *Tắt tài khoản*, *Mở khoá*, *Vào thùng rác*.
- Thùng rác (*Thùng rác*): *Khôi phục* hoặc *Xoá hẳn*; tự xoá hẳn sau số ngày hiện trên dòng.
- Token: menu tài khoản › *Token của tôi* (admin thấy mọi token, kèm *Tài khoản* và *Máy* đang dùng); *Thu hồi* token bị lộ.

> Không gửi token hay mật khẩu qua chat, tài liệu hay memory của Hive.

## Cài đặt service

**Cài đặt service** có các tab: *Quy trình*, *Agent*, *Tool*, *Context agent*, *Leader*, *Thành viên*, *Hệ thống*. Mỗi tab hiện tóm tắt; bấm *Sửa* để mở phần chỉnh.

| Tab | Nội dung |
|---|---|
| *Quy trình* | Chốt SDLC của service, trong trần của hub. (*Duyệt kế hoạch trước khi code* đặt ở trang **Quy trình** › *Quy trình & model*.) |
| *Agent* | Chính sách agent: model được dùng, mức tự chủ, phân loại task. Service chỉ siết chặt hơn hub, không nới được. |
| *Tool* | Bật/tắt tool trong danh mục cho service. |
| *Context agent* | `AGENTS.md` và những gì agent của service nhận; *Dọn memory định kỳ*. |
| *Leader* | Hướng dẫn, lệnh và việc tự chạy của leader chat. |
| *Thành viên* | Ai có vai gì trong service. |
| *Hệ thống* | Tạo/sửa hệ thống; thẻ *Service*: *Lưu trữ*, *Khôi phục*, *Xoá hẳn*; tình trạng truy cập repo trên các máy. |

### Lưu trữ và xoá một service

1. **Cài đặt service** › *Hệ thống* › thẻ *Service*.
2. *Lưu trữ*: ẩn service, giữ dữ liệu; *Khôi phục* để mở lại.
3. *Xoá hẳn*: gõ tên service để xác nhận. Hub tự backup trước khi xoá; backup này được ghim.

> Cảnh báo: sau khi xoá hẳn, chỉ bản backup mang lại được dữ liệu (xem *Khôi phục một service* bên dưới).

Muốn ẩn một project key đã xong việc mà không xoá gì: **Quản trị** › *Chính sách* › *Service nghỉ* › *Cho nghỉ*; *Mở lại* để đảo ngược.

## Backup và khôi phục

Backup bật khi hub có cấu hình thư mục backup (lúc cài hub, hoặc biến `HIVE_BACKUP_DIR`). Hub tự backup theo chu kỳ và trước khi chạy migration.

1. **Quản trị** › *Hub*. Dòng *Backup* hiện lần backup cuối.
2. *Backup ngay*: tạo một bản ngay (ví dụ trước một thao tác rủi ro). Bản này được ghim.
3. Danh sách *Các bản backup*: *Bản backup*, *Lý do* (*Khởi động*, *Định kỳ*, *Backup tay*, *Trước khi xoá <service>*), *Dung lượng*, *Ghim*.
   - *Ghim* / *Bỏ ghim*: bản ghim không bị xoay vòng xoá (trong thời hạn ghim; tổng dung lượng ghim có trần).
   - *Tải về*: tải tệp backup.

### Khôi phục một service

1. Ở bản backup còn service đó (thường là *Trước khi xoá <service>*), bấm *Khôi phục project*.
2. Chọn *Project trong bản backup*, gõ tên để xác nhận, bấm *Khôi phục*.
3. Hub chép mọi dòng của service về trong một giao dịch và gỡ trạng thái đã xoá.

> Chỉ khôi phục được service đang không có dữ liệu trên hub: khôi phục không gộp dữ liệu. Khôi phục cả hub làm trên máy chủ, xem `README.md` gốc, mục *Backup, khôi phục, nâng cấp*.

## Cập nhật app cho cả team

App desktop tải bản mới từ hub. Admin điều khiển rollout ở **Quản trị** › *Phiên bản app*:

1. Danh sách *Bản phát hành*: chọn bản, bấm *Đặt làm bản đích*.
2. *Tự tải bản mới*: bật/tắt.
3. *Cài khi nào*: *Hỏi người dùng*, *Khi thoát app*, hoặc *Khi máy hết run*.
4. *Tạm dừng* / *Tiếp tục phát hành* bất cứ lúc nào. Bảng máy hiện *Hiện tại*, *Đích*, trạng thái cập nhật.
5. *Bản tối thiểu để nhận run từ hub*: máy chạy bản cũ hơn không nhận run.

Trên máy người dùng: thanh trên hiện *Khởi động lại để lên vX*; hoặc **Máy này** › *Cập nhật* › *Cài và khởi động lại*. Bật *Tự cập nhật khi không có run* (Gói agent › *Cài đặt runner*) để app tự cài khi rảnh.

> Bản mới cũng có ở https://github.com/tdduydev/xdev-hive/releases cho máy cài lần đầu.

## Thông báo và webhook

1. **Quản trị** › *Thông báo & webhook* › *Thêm webhook*.
2. Chọn Teams (Workflows) hoặc Slack (Incoming Webhook), dán URL (chỉ `https`), chọn sự kiện, lọc theo service, chọn ngôn ngữ tin.
3. *Gửi thử* để kiểm. URL được lưu che trên trang.

## Thao tác của agent cần người duyệt

Agent gọi thao tác xoá hay gỡ dữ liệu (ví dụ xoá service) sẽ không chạy ngay: hub giữ lại thành một đề xuất thao tác. Người có quyền thấy nó ở **Hôm nay** và tab *Chờ duyệt*, bấm *Xem thao tác* để đọc method và dữ liệu, rồi mới duyệt. Duyệt chạy bằng quyền của người duyệt; *Nhật ký* ghi cả agent lẫn người duyệt.

## Máy của team

**Máy & agent** › *Bản đồ agent* (admin hub):

- *Dự án trên từng máy*: *Thêm dự án vào máy* (chọn dự án, đường dẫn tuyệt đối, URL clone nếu thư mục chưa có), *Gửi lệnh thêm*; *Gỡ khỏi máy*. Máy nhận lệnh ở nhịp kế tiếp và báo kết quả. Gỡ không xoá thư mục.
- *Tool* của từng máy: *Cho phép trên máy này* cho tool từ hub.
- Tab *Đội máy*: chọn máy offline rồi *Xoá máy offline* để bỏ khỏi danh sách (máy còn chạy sẽ hiện lại ở nhịp kế tiếp).
