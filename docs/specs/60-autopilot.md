# 60. autopilot: chỉ chat ra lệnh, Hive tự làm hết

Ngày 7/10 bạn hỏi: "sao mỗi lần làm task mình phải dí task, chứ không phải chỉ cần chat ra lệnh rồi tự làm?". Câu trả lời: agent đã tự chạy khi có run, nhưng ba khâu nối giữa các run vẫn làm tay trong một phiên chat:
1. chọn việc và giao (spec, task, máy/gói, `runs.dispatch`);
2. ghép các nhánh `ai/*` và chạy cổng kiểm (typecheck → test → e2e → e2e:mobile → build → smoke);
3. phát hành (version, release, deploy hub, rollout, cập nhật máy).

Bạn chọn: dây chuyền tự chạy, **xanh thì tự phát hành**, chỉ hỏi người khi cần quyết định.

Đã có sẵn để dùng lại:
- Gán agent rồi tự chạy khi rảnh (50).
- Bộ chọn model (54).
- Chốt và chế độ tự động trong *Quy trình* (34, 56).
- Leader chat tự chạy đề xuất (29c, 37b).
- Chia việc lớn rồi gộp (31c), chuỗi vai (31d).
- Thời hạn run (58c).
- `--only` của e2e (58d).
- Script ghép lô (59g), tự cập nhật khi rảnh (59f), ghi chú phát hành (59h), gom lỗi log (59i).
- Giao lại run (59e).

## 60a. auto-dispatch

Hub tự giao task sẵn sàng cho gói đang rảnh.

- Cài đặt dự án *Tự giao task* (bật mặc định khi preset là *Tự động tối đa*). Task `todo` đã hết phụ thuộc và chưa có agent sẽ được hub chọn máy và gói theo bộ chọn model (54c), quota (55) và loại gói được phép của dự án. Hub gán bằng `tasks.assign`, rồi máy tự chạy như 50.
- Thứ tự: ưu tiên của task, sau đó task chặn nhiều task khác, sau đó task cũ nhất. Giới hạn song song theo `maxParallel` của dự án và của máy.
- Run lỗi hay hết giờ thì tự *Giao lại* (59e) một lần sang gói khác, làm tiếp trên branch. Lần thứ hai thì task chuyển `blocked` kèm lý do, hiện ở *Hôm nay*.
- Nhật ký ghi mỗi lần hub tự giao.

## 60b. merge-queue

Hàng chờ merge chạy trên một máy được chỉ định.

- Máy có vai *Cổng kiểm* (cài đặt máy, mặc định tắt). Máy đó lấy các task `review` có branch, theo thứ tự xong trước vào trước. Máy gom thành lô (tối đa N nhánh hoặc sau M phút) bằng script 59g, ghép thử lên main, rồi chạy cổng kiểm của dự án (lệnh khai ở cài đặt dự án; xdev-hive dùng chuỗi ở AGENTS.md).
- Nhánh xung đột hoặc cổng kiểm đỏ thì loại khỏi lô và tạo task `INT-<lô>` hoặc `LAND-<task>` kèm file, đoạn xung đột, bước lỗi, log và ảnh. Hub tự giao task đó như 60a.
- Lô xanh thì push main (hoặc mở MR/PR khi dự án dùng MR) và chuyển các task sang `done` với note *Đã vào main ở <sha>*.
- Trang *Agent đang chạy* có thẻ *Hàng chờ merge*: lô đang chạy, bước, nhánh bị loại và vì sao.

## 60c. auto-release

Tự phát hành sau mỗi lô xanh.

- Chốt mới *Phát hành* trong *Quy trình* (người hoặc tự động, trong trần của hub). Khi là tự động: tăng version, đánh dấu roadmap của các task trong lô, chạy release (59h soạn ghi chú), deploy hub nếu dự án có lệnh deploy, đặt rollout 100%. Các máy tự cập nhật khi rảnh (59f).
- Lệnh release và deploy là của dự án (cài đặt dự án, chạy trên máy *Cổng kiểm* với secret trong máy đó, không đưa lên hub). Hub chỉ biết kết quả.
- Phát hành lỗi thì dừng hàng chờ, tạo task `OPS-release-<ver>` và báo ở *Hôm nay*.
- Sau khi deploy, 59i kiểm log; lỗi lặp nhiều thì cảnh báo.

## 60d. chat-to-plan

Chỉ cần chat ra lệnh.

- Bạn nhắn leader *Toàn hub* (hoặc leader của một service) một yêu cầu. Leader viết spec ngắn (tài liệu hệ thống hoặc service), tách thành task có tiêu chí xong và phụ thuộc, rồi đề xuất *Kế hoạch* gồm spec, danh sách task và lô dự kiến.
- Bạn bấm *Làm* một lần, hoặc để leader tự làm theo cài đặt *Leader tự chạy*. Sau đó task đi qua 60a → 60b → 60c.
- Leader chỉ hỏi lại khi cần quyết định thật (hướng thiết kế, bỏ yêu cầu, nới quyền, đụng production). Ngoài ra leader báo tiến độ trong thread: lô nào đã lên, lô nào đang kiểm, task nào bị chặn.

## Không làm

- Không tự nới quyền của máy hay gói (vd. mở mạng cho agent trên server production) mà không có người duyệt.
- Không tự dùng fast mode, `max` hay Fable (giữ như 54).
- Không phát hành khi cổng kiểm chưa xanh trọn, kể cả khi lỗi trông như chập chờn. Lỗi chập chờn thì chạy lại một lần; vẫn đỏ thì tạo task.
