# Quickstart: kiểm tay chạy delivery trên worker

Dành cho người điều phối, sau khi hub và worker đã nối `channel` (xem SUMMARY-SPEC032.md).

## 1. Chuẩn bị

1. Chạy hub với `HIVE_DELIVERY_OUTBOUND` không đặt (mặc định tắt).
2. Trên máy trong mạng nội bộ chạy `hive-worker`, đăng nhập vào hub.
3. Thêm credential giả bằng màn "Bí mật" (tab Credential triển khai): `jenkins-test`.
4. Dựng Jenkins thử bằng container, hoặc dùng máy chủ thật của đội thử.

## 2. Chọn máy

1. Mở môi trường, khai máy chạy deploy là máy vừa nối. Kỳ vọng: web hiện máy đó "trực tuyến".
2. Tắt worker. Kỳ vọng: lần triển khai mới ở `chờ`, sau 15 phút `failed` mã `runner_offline`.

## 3. Mỗi cách chạy

Với mỗi cách (`ssh-script`, `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl`): tạo lần triển khai, duyệt bằng người
thứ hai, theo dõi. Kỳ vọng:

- bước hiện trên web trong 5 giây;
- cột "Máy chạy" có tên máy;
- khung log là thẻ "Log nằm trên máy X";
- `delivery-logs/<jobId>.log` có trên máy worker, không có trên hub.

## 4. Credential

1. Xoá `jenkins-test`, chạy lại. Kỳ vọng: `missing_credential`.
2. Tìm giá trị token trong cơ sở dữ liệu hub, trong audit và trong lịch sử. Kỳ vọng: không thấy.
