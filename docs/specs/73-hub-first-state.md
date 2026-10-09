# 73. hub-first-state: máy chỉ để chạy, mọi thứ còn lại nằm trên hub và remote

Hỏi 9/10: "kiến trúc đổi lại là mọi thứ lưu ở trên web, còn mấy máy client là dùng để chạy code thôi?" Người dùng chọn làm, 73a trước.

## Vì sao

Hub đang lưu task, note bàn giao, run, log, memory, tài liệu, skill, artifact và chat. Riêng nhánh `ai/<task>`, commit WIP và worktree chỉ nằm trên máy đã chạy. Runner không push; chỉ merge queue push. Hệ quả thấy trong roadmap 72 (8–9/10):

- Hub tự giao lại run lỗi sang máy khác. Máy đó không có nhánh, nên R-72b làm lại từ main và mất R-72a, còn INT-main-e2e bị tách thành hai nửa xung đột.
- Leader phải `git fetch xdev-server:hive-work/...` qua SSH để lấy nhánh của .52, và tạo nhánh tay trên Mac trước khi giao.
- App thoát hoặc máy tắt (cả hai đều xảy ra 9/10) thì việc dở chỉ còn ở một máy.

## 73a. branch-on-remote

- Sau mỗi run (xong, lỗi, huỷ, hết giờ, kể cả commit WIP khi app thoát), runner push `ai/<task>` (và `ai/<task>+c<n>` của best-of-n) lên remote của dự án (`git.remote`, mặc định `origin`). Push dùng `--force-with-lease` theo SHA hub đã biết, để không đè việc của máy khác.
- Hub ghi cho mỗi run: nhánh, SHA đầu, SHA cuối, đã push hay chưa (và lỗi push). `runs.list`/`runs.get` trả các trường này; UI run hiện SHA và trạng thái push.
- Trước khi chạy một task đã có nhánh, runner `git fetch <remote> ai/<task>`. Nếu nhánh trên remote mới hơn bản trên máy, máy dùng bản remote: làm tiếp đúng chỗ dù run trước chạy ở máy khác. Redispatch `continueBranch` dùng SHA hub ghi.
- Push lỗi (không có quyền, mạng): run vẫn xong, hub ghi `pushError`, và lần chạy sau thử push lại. Không bao giờ push nhánh khác ngoài `ai/*`. Không push main (việc của merge queue).
- Credential: dùng git của máy (SSH key hoặc credential helper). Hive không lưu token git mới. Máy không push được thì heartbeat báo, và hub tránh giao task đã có nhánh remote cho máy đó.
- Test: runner (push sau run, fetch trước run, lease khi nhánh remote đổi, push lỗi), core (trường mới, migration), e2e (run hiện SHA và push).

## 73b. platform-routing

Task có `platforms` (windows / linux / mac, tuỳ chọn). Hub chỉ giao, kể cả tự giao và tự giao lại, cho máy đúng nền tảng (heartbeat đã có OS). Board và chat hiện nhãn nền tảng; MCP `task_create`/`propose_task` nhận trường này.

## 73c. ephemeral-worktree

Worktree trên máy là bộ nhớ tạm: sau khi nhánh đã push và run xong, máy tự dọn worktree theo quota ổ đĩa. Mất máy không mất việc. Trang Worktree (63f) hiện "đã push / chưa push".

## Tách app / web / admin (bổ sung 9/10)

Người dùng: "tính năng nào của app, tính năng nào của web, tính năng nào của admin, cho dễ quản trị, build và deploy". Theo chiến lược 73 (máy chỉ để chạy):

| Nơi | Có gì | Ghi chú |
|---|---|---|
| **App desktop, chế độ hub** | Chỉ việc của chính máy này: trạng thái máy (online, CPU/RAM/ổ đĩa), gói agent (đăng nhập CLI, quota, bật/tắt, ưu tiên), run đang chạy và đã chạy trên máy (log), worktree và dung lượng, công cụ và setup (CLI, MCP shim), cài đặt máy (nhận việc, số run song song), cập nhật app. Mọi thứ khác là nút "Mở trên web". | Bỏ Board và Hôm nay khỏi app (roadmap 44): xem trên web. |
| **App desktop, chế độ cục bộ** (không hub) | Giữ đủ mọi trang như hiện tại, vì app lúc đó là cả hệ thống. | Không đổi. |
| **Web, người dùng** | Mọi việc: Hôm nay, Task, Chat, Quy trình, Tính năng, Lượt chạy (mọi máy), Tài liệu, Memory, Skill, Artifact, Lịch sử, Sơ đồ, Máy & agent (xem mọi máy), Terminal. | Menu theo quyền. |
| **Web, quản trị** (nhóm Quản trị, chỉ hiện khi có quyền) | Người dùng & quyền, vai trò hub, sơ đồ tổ chức, chính sách agent và model, ngân sách, cảnh báo, nhật ký, thông báo và webhook, phiên bản app và rollout, vận hành hub (backup, log). Cài đặt service cho lead của service. | Không có trang trùng giữa người dùng và quản trị. |

Hệ quả build và deploy: giao diện web do hub phục vụ, nên đổi web thì chỉ cần **deploy hub**. App desktop chỉ cần **release** khi runner, main process, setup CLI hoặc heartbeat đổi. Vì app hub-mode còn ít trang, đa số thay đổi giao diện không cần release app.

### 73d. app-runner-console
App hub-mode chỉ còn các mục của máy (bảng trên). Board và Hôm nay của máy chuyển thành link mở web. Chế độ cục bộ giữ nguyên. Shell mới của 72b dùng chung, chỉ khác danh sách mục. e2e và smoke cập nhật.

### 73e. admin-area
Gom mọi trang quản trị vào nhóm Quản trị của web, theo quyền (hub admin, owner; lead cho Cài đặt service). Kiểm tra: người không có quyền không thấy và không gọi được.

### 73f. release-split
`release.mjs` và autopilot 60c xác định thay đổi thuộc hub hay app từ diff so với bản trước. Chỉ đổi web/core phía hub thì chỉ deploy hub. Đổi `apps/desktop` (main, runner, preload) hoặc runtime dùng chung với app thì release app và rollout. Ghi rõ trong ghi chú phát hành.

## Thứ tự

73a trước (chặn đúng lỗi đang làm chậm 72), rồi 73b, 73c. Việc trên runner phải kiểm cả Mac, Ubuntu và Windows: dùng máy đúng nền tảng khi giao.
