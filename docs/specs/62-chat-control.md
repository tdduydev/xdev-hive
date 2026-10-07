# 62. chat-control: quản trị Hive bằng chat

Hỏi ngày 7/10: "phần chat trên giao diện client để giao task, nghiên cứu, vv… làm cái đó đi cho dễ giao task quản trị trên Hive". Hiện đã có: leader chat của service và *Toàn hub* (17, 29, 37), đề xuất và *Leader tự chạy* (29c), *Kế hoạch* từ chat (60d), tự giao task (60a). Còn thiếu để chat thành chỗ quản trị chính:

- Leader chỉ chạy bằng gói Claude, nên khi Claude hết quota thì chat đứng.
- Leader chưa nhận việc nghiên cứu: tìm hiểu một chủ đề, so sánh phương án, đọc web hay tài liệu rồi viết báo cáo.
- Muốn giao việc phải gõ tự do; chưa có lối tắt cho các việc hay làm: giao task, nghiên cứu, xem tình trạng, phát hành.
- Chat là một trang riêng: đang ở trang khác thì phải chuyển sang Chat mới ra lệnh được.

## 62a. codex-leader

Leader chạy được bằng gói Codex.

- *Chat mới* và cài đặt leader (máy, gói, model, effort) cho chọn gói Codex. Mặc định của dự án lấy gói còn quota theo thứ tự ưu tiên của máy.
- Runner chạy leader Codex bằng `codex exec`, giữ đúng phiên cho các câu trả lời sau (`codex exec resume <thread>`), MCP xdev-hive của leader như Claude (danh tính của run, quyền chỉ đọc cộng các tool propose_*), lệnh được phép của leader như Claude (`git -C` theo danh sách cho phép).
- Câu trả lời hiện dần như Claude (CodexStream). Token và chi phí ghi vào thread.
- Gói Claude hết quota giữa chừng thì thread chuyển sang Codex ở câu sau, có ghi rõ trong thread (không đổi giữa một câu trả lời).
- Test runner bằng fake-agent cho Codex: tạo phiên, resume, propose.

## 62b. research-from-chat

Giao việc nghiên cứu từ chat.

- Leader có đề xuất `research.start`: chủ đề, câu hỏi cần trả lời, phạm vi (service, hệ thống hay cả hub), nguồn (repo, tài liệu Hive, web) và định dạng kết quả (báo cáo ngắn, so sánh phương án, đề xuất task).
- Chạy thành run *research* chỉ đọc. Run được truy cập web khi gói và chính sách của dự án cho phép, nếu không thì chỉ dùng repo và tài liệu. Kết quả là `report.md` lưu làm artifact (61a) và tài liệu nháp `system/<hệ thống>/research/<slug>` hoặc `project/<service>/research/<slug>` (cần duyệt như tài liệu).
- Thẻ *Nghiên cứu* trong thread hiện trạng thái, rồi tới link báo cáo (xem trước như 61a), các nguồn đã đọc, và nút *Biến thành Kế hoạch*. Nút này đưa phần đề xuất của báo cáo sang 60d.
- Test hub (đề xuất, quyền, lưu báo cáo), runner (run research chỉ đọc), UI và bước e2e.

## 62c. chat-shortcuts

Lối tắt trong ô chat. Tên lệnh bằng tiếng Anh, luôn có gợi ý (người dùng chọn ngày 7/10).

- Gõ `/` là hiện ngay danh sách gợi ý: tên lệnh, mô tả ngắn theo ngôn ngữ giao diện, ví dụ. Danh sách lọc theo chữ đang gõ; chọn bằng mũi tên rồi Enter/Tab, hoặc chạm.
- Các lệnh:
  - `/assign`: mô tả việc, leader đề xuất *Kế hoạch*.
  - `/research`: giao việc nghiên cứu (62b).
  - `/status`: tình trạng (xong, đang chạy, chờ review, bị chặn, quota).
  - `/release`: hàng chờ merge và phát hành (60b, 60c).
  - `/cancel <run>`, `/retry <run>`.
- Lệnh có tham số thì gợi ý tiếp: `/cancel` gợi ý các run đang chạy, `/retry` gợi ý run lỗi gần đây, `/assign` và `/research` gợi ý service trong phạm vi.
- Hàng chip trên ô chat cho 4 lệnh hay dùng nhất. Trên điện thoại, chip cuộn ngang và có vùng chạm 44px.
- Leader hiểu các lệnh này (qua lời dặn đầu phiên và skill hive-leader). `/status` trả về một thẻ tình trạng có số liệu và link, không chỉ chữ.

## 62d. chat-everywhere

Ra lệnh từ bất kỳ trang nào.

- Nút *Hỏi leader* trên thanh trên cùng (phím tắt mở được) mở khung chat bên phải. Trên điện thoại khung này chiếm cả màn hình. Phạm vi lấy theo phạm vi đang chọn. Đang xem một task, run hay tính năng thì khung có sẵn ngữ cảnh đó (link và mã) để hỏi hay giao tiếp.
- Khung dùng chung thread với trang Chat (mở ở trang Chat thì vẫn đúng thread đó). Đóng khung không mất bản nháp.
- Admin hub có thêm lựa chọn *Toàn hub* trong khung.
