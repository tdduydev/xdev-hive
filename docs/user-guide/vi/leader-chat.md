# Chat với leader

Leader là một agent chạy trên máy của team, trả lời trong trang **Chat**. Leader đọc task, run, tài liệu, memory và chi phí của phạm vi, rồi đề xuất việc cụ thể. Mọi đề xuất chỉ chạy khi có người *Xác nhận*, trừ loại đã được cho tự chạy. Bản tiếng Anh: [../en/leader-chat.md](../en/leader-chat.md).

Quyền cần có: dùng chat cần quyền chat của service. Đề xuất chạy bằng quyền của người bấm *Xác nhận*.

## Bắt đầu một cuộc chat

1. Mở **Chat** (⌘2), bấm *Chat mới*.
2. Ở *Phạm vi, máy và gói*: chọn service (admin hub có thêm *Toàn hub*), máy sẽ chạy leader, và gói (để *máy chọn gói còn quota* nếu không cần ghim).
3. Gõ tin, bấm *Gửi*. Trạng thái hiện *Chờ <máy> nhận…*, rồi *Đang viết…*.

> Không có máy nào nhận? Máy cần bật *Nhận việc trên máy này* (app › Gói agent) và có repo của service.

Hỏi nhanh từ trang khác: bấm *Hỏi leader* ở thanh trên. Khung chat mở kèm *Ngữ cảnh gửi kèm* (trang bạn đang xem); bấm *Bỏ ngữ cảnh* nếu không muốn gửi.

## Xác nhận đề xuất

Câu trả lời có thể kèm khối *Leader đề xuất*: tạo task, chuyển trạng thái, phân loại, chạy task, huỷ run, merge MR/PR, bật/tắt gói của máy, đổi chính sách, dừng/cho agent chạy lại, yêu cầu máy cài, bật/tắt tool. Mỗi đề xuất có *Lý do*.

1. Đọc từng đề xuất.
2. Bấm *Xác nhận* (chạy bằng quyền của bạn) hoặc *Bỏ*.
3. Nhiều đề xuất: *Xác nhận tất cả (n)* hoặc *Bỏ qua tất cả*.

Đề xuất chưa ai quyết cũng hiện ở **Hôm nay** › *Cần bạn quyết*.

## Lệnh nhanh

Gõ `/` trong ô nhập để thấy gợi ý:

| Lệnh | Làm gì |
|---|---|
| `/assign` | Giao việc |
| `/research` | Nghiên cứu chỉ đọc |
| `/status` | Thẻ *Tình trạng*: task xong, run đang chạy, task chờ review, task bị chặn, quota |
| `/release` | Phát hành |
| `/cancel <run>` | Huỷ run |
| `/retry <run>` | Giao lại run |

## Kế hoạch và nghiên cứu

- **Kế hoạch**: nhờ leader biến yêu cầu thành *Kế hoạch* (spec, *Task và tiêu chí xong*, *Lô dự kiến*). Bấm *Làm* để tạo spec và task, hoặc *Cần chỉnh*.
- **Nghiên cứu**: leader xếp một run chỉ đọc theo *Phạm vi*, *Nguồn yêu cầu* (repo, tài liệu Hive, web) và *Định dạng kết quả*. Xong thì có *Xem báo cáo*, *Tài liệu nháp cần duyệt* và *Biến thành Kế hoạch*.

## Tệp, model, tìm kiếm

- *Đính kèm*: thêm tệp vào tin (có giới hạn số tệp mỗi tin).
- *Model và mức nỗ lực*: chọn *Model*, *Mức nỗ lực*; *Lưu làm mặc định* cho các chat sau.
- *Tìm theo tiêu đề hay nội dung* trong danh sách chat; *Tìm trong tin đã tải* trong một chat.
- *Đổi tên*, *Xoá cuộc chat* (chỉ xoá được khi không còn đề xuất đang chờ).

## Cấu hình leader (quản lý service)

Mở **Chat** › *Hướng dẫn leader*, hoặc **Cài đặt service** › tab *Leader*:

1. *Hướng dẫn*: chỉ dẫn riêng cho leader của service. Không có bản riêng thì dùng bản chung của nhóm (skill `hive-leader`).
2. *Lệnh leader được chạy*: danh sách lệnh leader được chạy trên máy (có giới hạn số lệnh).
3. *Leader tự chạy*: tick loại đề xuất leader được tự làm không cần xác nhận. Mặc định mọi loại *luôn chờ duyệt*.
4. Bấm nút lưu tương ứng: *Lưu cho <service>* (hướng dẫn), *Lưu lệnh cho <service>*, *Lưu việc tự chạy cho <service>*.

> Cảnh báo: chỉ cho tự chạy những loại đề xuất bạn chấp nhận được khi không ai xem trước, ví dụ *Nghiên cứu*. Thao tác xoá dữ liệu do agent gọi vẫn luôn chờ người duyệt.
