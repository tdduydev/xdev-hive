# Quickstart: kiểm tay máy nhiều tổ chức

Cần: hai hub dev (hoặc một hub, hai tổ chức), hai mã đăng ký, một máy có app desktop.

## 1. Nâng cấp từ một đăng ký

1. Cài bản cũ, đăng ký với tổ chức A, gắn một dự án, giao một run dài.
2. Cài bản mới khi run đang chạy.
3. Kiểm: `hive-worker registrations list` có một mục `reg_legacy`; run vẫn báo tiến độ; hub A thấy cùng máy.
4. Không có file nào bị chuyển: `worker.json`, `projects.json` ở chỗ cũ.

## 2. Thêm tổ chức B

1. App → Cài đặt → Tổ chức trên máy → Thêm. Dán mã của B.
2. Kiểm: hai dòng trực tuyến; hub B có máy mới, tên khác; hub A không đổi.
3. Thêm lại bằng mã khác của B: app báo đã có, đề nghị đăng ký lại.

## 3. Cách ly

1. Gắn `shop` với A, `crm` với B. Giao một run ở mỗi hub cùng lúc, prompt: "In env, liệt kê `$CLAUDE_CONFIG_DIR`, skill,
   MCP server, rồi thử đọc thư mục `xdev-hive/orgs`."
2. Kiểm: mỗi run chỉ thấy hub, token, skill, MCP của mình; Linux, macOS báo không đọc được thư mục đăng ký kia.
3. Từ terminal của run A, chạy `hive memory propose …` với `HIVE_RUN_SESSION` bỏ đi: bị từ chối.

## 4. Tài khoản AI

1. Gán gói "Cá nhân" dùng chung, gói "B" chỉ cho B.
2. Bật `aiAccountSharing = dedicated` ở B. Giao run ở B: chỉ dùng gói "B".
3. Admin đội A tắt gói "Cá nhân" từ web: bị từ chối "Tài khoản do chủ máy quản lý".

## 5. Lập lịch

1. Máy `M = 2`, `L(A) = 2`, `L(B) = 2`. Xếp 5 run ở mỗi hub.
2. Kiểm: luôn tối đa 2 run; khi cả hai có việc, mỗi bên 1; hub ghi `offer_rejected` lý do `machine_busy` và run không
   bị loại khỏi máy.

## 6. Gỡ B

1. Gỡ B, chọn gửi nốt hộp thư đi.
2. Kiểm: thư mục `orgs/<B>` mất; keychain không còn token B; A vẫn chạy; `projects.json` của A không đổi.

## 7. Phân quyền hub

1. Người dùng viewer của đội X mở `leader.threads.list`: không thấy hội thoại của đội Y.
2. Viewer từ chối đề xuất: lỗi `TEAM_ROLE_REQUIRED`.
3. Token cá nhân của A gọi `/v1/orgs/<B>/…`: 401.
