# 42. Web dùng được trên điện thoại

Viết ngày 4/10. Người dùng nói: "hệ thống này giao diện mobile không sử dụng được, xem tối ưu đi". Họ muốn Codex làm phần code: codex-1 trên Mac mini, cùng gói Codex thứ hai. Khi Codex hết quota thì dùng gói có kỳ quota sắp reset. Việc chọn gói này nằm ở mục 24c của roadmap.

## Hiện trạng (main f5c5c0a, e2e web ở 390×844)

Ảnh "trước": chạy e2e web với cửa sổ 390×844 (sửa tạm `apps/web/e2e/browser.mjs`, cửa sổ đang cố định 1440×900). 30/35 bước qua.
- **Bố cục hai, ba cột không xếp chồng**:
  - *Hôm nay* (danh sách + chi tiết): phần chi tiết bị cắt, chữ dồn thành mỗi dòng một chữ;
  - *Tài liệu* (cây trang + trang): trang bị đẩy ra ngoài màn hình.
- **Bảng không co**: *Đợt chạy* và danh sách *Task* ép cột tên task tới mức mỗi dòng một ký tự.
- **Cả trang tràn ngang**: có thanh cuộn ngang ở đáy.
- **Kanban**: cột thứ hai bị cắt. Đầu trang *Task* có đoạn giải thích dài và form tạo task chiếm nửa màn hình.
- Trang ổn: *Thành viên*, hộp *Hướng dẫn cho leader*.
- Bước e2e không qua ở 390px: login-token, login-password, scope-search-tasks, admin-grants-a-role, docs-markdown. Phần lớn do phần tử nằm sau menu gập.

## Nguyên tắc chung

- Điểm gãy: dưới `md` (768px) là điện thoại. Từ `md` trở lên giữ nguyên như bây giờ: e2e 1440×900 phải qua như trước.
- Không trang nào tràn ngang ở 390px. Bảng rộng thì đổi thành thẻ, không cuộn cả trang.
- Ô nhập cỡ chữ ≥ 16px trên điện thoại (iOS không tự phóng to). Nút bấm cao ≥ 40px.
- Giữ token và component DS. Chữ mới có trong vi và en.
- Mỗi bước phát hành kèm ảnh trước và sau ở 390×844 (bộ chạy của 42a).
- Shell và trang dùng chung với app desktop: app không được đổi ở bề rộng cửa sổ thường.
- Agent không tăng version, không đánh dấu roadmap.

Thứ tự:

```
42a ─┬─ 42b
     ├─ 42c
     └─ 42d   (42d chờ cả R-39g)
```

## R-42a. Khung trên điện thoại và bộ chạy e2e cỡ điện thoại

- e2e:
  - kích thước cửa sổ đọc từ `HIVE_E2E_W` / `HIVE_E2E_H` (mặc định 1440×900);
  - script `npm run e2e:mobile -w @xdev-hive/web` chạy ở 390×844;
  - ở chế độ điện thoại, sau mỗi bước kiểm không tràn ngang (`document.documentElement.scrollWidth <= innerWidth + 1`) và ghi bước nào tràn;
  - bước cần menu thì mở ngăn kéo menu trước.
- Khung (thanh bên, topbar, thanh trạng thái) dưới `md`:
  - thanh bên là ngăn kéo, đóng sau khi chọn trang;
  - topbar gọn: tiêu đề cắt chữ, *Task mới* chỉ còn icon, ô tìm thành icon mở bảng lệnh;
  - thanh trạng thái ẩn hoặc thu một dòng;
  - vùng nội dung `min-w-0` và không tràn ngang; toast vừa bề ngang.
- Đoạn giới thiệu đầu trang: dùng một component chung, trên điện thoại hiện dòng đầu kèm *Xem thêm*.
- **Xong khi**:
  - e2e 1440×900 qua như trước;
  - `e2e:mobile` chạy hết các bước, các bước đăng nhập và chọn phạm vi qua;
  - danh sách bước còn tràn ngang được ghi vào bàn giao, để 42b–d xử lý.

## R-42b. Danh sách và chi tiết trên điện thoại

- Áp cho *Hôm nay*, *Tài liệu*, *Lượt chạy*, *Chat* (danh sách thread và tin nhắn), *Skill*, *Memory*, *Đề xuất*, *Spec*.
- Dưới `md` chỉ hiện một ngăn mỗi lúc: danh sách → bấm → chi tiết toàn màn hình có nút quay lại. Địa chỉ giữ mục đang chọn, nên nút quay lại của trình duyệt cũng đúng.
- *Tài liệu*: cây trang vào ngăn kéo. Thanh công cụ (Xem, Sửa, Markdown, Đọc, Trợ lý…) gói vào một menu. Trình soạn Tiptap dùng được bằng ngón tay.
- **Xong khi**: `e2e:mobile` không còn tràn ngang ở các trang trên. Ảnh trước và sau của *Hôm nay*, *Tài liệu*, *Chat*.

## R-42c. Bảng thành thẻ trên điện thoại

- Dưới `md`, mỗi hàng bảng thành một thẻ: dòng chính (tên task, tên máy…), các cặp nhãn: giá trị, và nút ở cuối. Làm một mẫu dùng chung rồi áp cho:
  - *Task* (dạng danh sách), *Đợt chạy*, *Bản đồ agent* và các bảng của nó, *Hàng đợi*, *Chi phí*, *Cảnh báo*;
  - *Nhật ký*, *Người dùng*, *Token*, *Webhook*, *Phiên bản app*, *Hub*.
- **Xong khi**: `e2e:mobile` không còn tràn ngang ở các trang trên. Ảnh trước và sau của *Đợt chạy* và danh sách *Task*.

## R-42d. Kanban, form và hộp thoại trên điện thoại

- Kanban dưới `md`:
  - mỗi cột rộng khoảng 85% màn hình, cuộn ngang có `scroll-snap`;
  - thanh tab trạng thái có số đếm để nhảy cột;
  - kéo thả được thay bằng chọn trạng thái trong panel task.
- Form tạo task gập sau nút *Task mới*.
- Hộp thoại thành tấm toàn màn hình (sheet) trên điện thoại.
- Làm trên bản đã có 39g (Board vừa màn hình).
- **Xong khi**: `e2e:mobile` không còn tràn ngang ở *Task* (Kanban) và các hộp thoại. Ảnh trước và sau của Kanban.
