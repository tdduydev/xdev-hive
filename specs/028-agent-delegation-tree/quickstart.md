# Quickstart: kiểm chứng spec 028

## Chuẩn bị

Như [spec 027 quickstart](../027-hub-client-model/quickstart.md#chuẩn-bị): database dev, hub, worker đã đăng ký, một dự án.

## US1: cây của phiên Leader

1. Mở trang Leader, tạo phiên "Phân quyền menu", nhờ Leader tạo hai task và giao run (duyệt đề xuất).
2. Mở tab "Cây giao việc": một gốc, hai task, mỗi task có run; run review nằm dưới run code.
3. Tự tạo một task trên web rồi nhờ Leader giao run cho task đó: task hiện trong cây với nhãn "người dùng tạo".
4. Đăng nhập bằng người không thuộc đội của dự án: cây ẩn task đó và báo "1 mục bị ẩn do quyền".
5. Test tự động: `apps/hub/src/modules/leader/tree.db.test.ts` (liên kết, run con, quyền, run cũ không có liên kết),
   `leader/rls.db.test.ts` (bảng `leader_delegations`).

## US2: cập nhật trực tiếp, mở terminal

1. Để cây mở, cho run đổi trạng thái: nút đổi trong 5 giây, không tải lại.
2. Bấm nút run: mở trang run. Trên app desktop máy chạy run: mở màn "Agent trên máy".
3. Thu gọn, mở rộng bằng chuột và phím mũi tên; lọc "chỉ đang chạy hoặc lỗi".
4. Test tự động: test component cây trong `packages/ui`, Playwright web với hub giả (`apps/web/e2e/delegation-tree.spec.ts`).

## US3: sub-agent

1. Chạy run Claude Code có agent gọi sub-agent: cây có nút sub-agent với loại, mô tả, token, thời gian.
2. Test tự động: `worker/internal/runner/subagent_test.go` đọc `testdata/claude-subagent-stream.jsonl` (bản ghi thật của
   Claude 2.1.306) và một fixture đồng bộ kiểu cũ; kiểm cha con, token, không có `prompt`/`summary` trong sự kiện.
3. Secret trong mô tả: test worker và hub che chuỗi giống token GitHub.

## US4: desktop

1. Mở app desktop, vào màn "Cây giao việc": danh sách phiên, cây của phiên chọn, run của máy này có dấu "máy này".
2. Tắt hub: màn báo "Hub đang vắng", không hiện cây cũ.
3. Test tự động: vitest màn cây với `hub_rpc` giả.
