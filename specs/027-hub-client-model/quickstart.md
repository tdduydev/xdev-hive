# Quickstart: kiểm chứng spec 027

Các kịch bản dưới đây chứng minh từng user story chạy đúng từ đầu đến cuối. Chi tiết hợp đồng ở [contracts/](contracts),
bảng ở [data-model.md](data-model.md).

## Chuẩn bị

- Database dev: `docker compose -f deploy/dev/compose.yaml up -d`, `pnpm --filter @xdev-hive/hub db:setup`.
- Hub: `pnpm --filter @xdev-hive/hub dev` (cổng 3000). Tạo tổ chức, đội, dự án `DEMO`, một task `DEMO-1`.
- Worker: `cd worker && go build ./cmd/hive-worker ./cmd/hive`, đăng ký máy với mã từ trang Máy, `hive-worker run`.
- `hive login --hub http://localhost:3000`.
- Test tự động chạy bằng `pnpm check` (hub, web, desktop) và `go test ./...` trong `worker/`.

## US1: một hợp đồng ghi

1. Gửi cùng một lần ghi hai lần:

   ```sh
   KEY=01JBTESTKEY000000000000001
   curl -sS -X POST localhost:3000/mcp -H "Authorization: Bearer $PAT" -H "Idempotency-Key: $KEY" \
     -H "X-Hive-Source: hive-cli" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"doc_comment","arguments":{...}}}'
   ```

   Lần hai cùng `$KEY`: `_meta["dev.xdev.hive/clientEvent"].outcome` là `duplicate`, bình luận chỉ có một, `audit_log`
   chỉ có một dòng `mcp.doc_comment`.
2. Huỷ task `DEMO-1` trên web rồi gọi `task_update` cho run của nó: kết quả `rejected`, `code` khác rỗng, task không đổi.
3. Mở lịch sử task trên web: mỗi dòng có nguồn, máy, người, giờ tạo trên máy, giờ hub nhận.
4. Test tự động: `apps/hub/src/modules/platform/client-events.db.test.ts`, `mcp/server.db.test.ts` (trùng, từ chối,
   không khoá), test bảng `CLIENT_WRITE_TOOLS` khớp registry.

## US2: hub vắng

1. Dừng hub. Trong Claude Code đã gắn `hive mcp`, gọi `task_update` và `doc_propose`: tool trả "Đã xếp hàng, chờ hub".
2. Gọi `doc_get`: lỗi "Hub đang vắng".
3. `hive outbox`: thấy 2 mục `pending`, trạng thái hub `down`. App desktop hiện "Hub đang vắng – 2 mục chờ gửi".
4. Khởi động lại máy (hay dừng rồi chạy lại `hive-worker`): `hive outbox` vẫn còn 2 mục.
5. Bật hub: trong vòng 1 phút hai mục thành `accepted`; `hive outbox` trống; hub có đúng hai dòng `client_events`.
6. Kịch bản từ chối: xếp hàng `doc_propose` với `baseVersion` cũ rồi bật hub. Mục thành `rejected`; app hiện lý do và hai
   nút "Bỏ", "Mở trên hub".
7. Giới hạn: đặt `HIVE_OUTBOX_LIMIT_BYTES=1048576` cho worker, xếp hàng mục 2 MB: lỗi `OUTBOX_FULL`, không mục nào bị xoá.
8. Test tự động: `worker/internal/outbox/*_test.go` (thứ tự theo stream, từ chối không chặn stream khác, 401 → `held`,
   hết hạn 14 ngày với đồng hồ giả, giới hạn dung lượng, quyền file trên cả ba hệ điều hành);
   `worker/cmd/hive/mcp_test.go` (hub giả trả lỗi mạng → xếp hàng; tool đọc → lỗi); e2e SC-001 trong
   `e2e/outbox.e2e.ts`: 20 sự kiện từ desktop, CLI, proxy MCP qua một lần tắt hub, không trùng, đúng thứ tự trong task.
9. SC-003: `go test ./internal/outbox -run TestDrain1000 -bench` với hub giả: 95% trong 1.000 mục xong dưới 1 phút.

## US3: token ngắn hạn

1. Đăng ký máy mới: `worker.json` không có `machineToken`, có `publicKey`, `keyStorage: "keychain"` (máy có keychain).
2. `hive-worker run`: log có "đổi access token, hạn 15 phút"; trang Máy hiện máy online.
3. Chép `worker.json` sang máy khác rồi chạy: hub từ chối (không có khoá riêng).
4. Thu hồi máy trên web: trong 15 phút worker bị ngắt và không nối lại được (SC-004).
5. Máy cũ có `hwm_`: nâng worker, chạy lần đầu: log có "đã đăng ký khoá máy"; gọi WSS bằng `hwm_` cũ nữa thì bị 401.
6. Dự án nối GitHub App: chạy run code, `git push` thành công; xem `run_events` có `gitCredential: "run"`. Dùng token đó
   push vào repo khác: GitHub từ chối. Sau 1 giờ token hết hạn.
7. Dự án nối GitLab: sau khi run xong, `run_git_tokens.revoked_at` có giá trị trong 10 phút.
8. Test tự động: `fleet/machine-auth.db.test.ts` (chữ ký, nonce hết hạn, máy thu hồi, `hwm_` bị thay), Go
   `worker/internal/machinekey` (keychain giả, rơi về file), `scm/run-git-token.db.test.ts` với GitHub/GitLab giả.

## US4: hub bền

1. Chạy compose với `hub` và `hub-jobs` tách. `docker compose pause hub-jobs`: `/api/v1/health` của `hub` vẫn 200,
   run vẫn được giao (timer giao run ở `api`).
2. Diễn tập: `deploy/drill.sh` → biên bản `backups/drills/<ngày>.md` có thời gian khôi phục, thời điểm khôi phục tới,
   số dòng và checksum khớp.
3. PITR: ghi task A, ghi lại giờ T, ghi task B; `deploy/pitr-restore.sh T` trên máy diễn tập: có A, không có B;
   `/api/v1/health` trả `dbEpoch` mới.
4. Máy có mục đã được nhận sau T: worker thấy epoch đổi, gửi lại, hub trả `accepted` (vì `client_events` đã mất cùng
   database) và dữ liệu B trở lại.
5. Nâng cấp hub trong lúc proxy MCP đang ghi: mọi lần ghi nằm trong hộp thư đi rồi tới hub; không mất mục nào.

## US5: ranh giới dữ liệu

1. Chạy run in ra `echo $DEMO_SECRET` và một chuỗi giống token GitHub. Kiểm database:
   `select count(*) from hive.run_logs where run_id = ...` bằng 0; tìm giá trị secret trong `run_events`,
   `client_events`, `audit_log`: không thấy (SC-006, chạy 100 lần trong e2e `e2e/data-boundary.e2e.ts`).
2. App desktop trên máy đã chạy run: mở run, thấy log đầy đủ; log 10 MB hiện trong 2 giây (SC-008).
3. Web và desktop của máy khác: thấy pha, thời gian, mã thoát, chi phí, câu "Log nằm trên máy <tên>", không có nút xem log.
4. Đặt chính sách giữ log 30 ngày, đẩy đồng hồ của worker (test) qua 31 ngày: thư mục run bị xoá.
5. Admin mở trang "Dữ liệu hub giữ": danh sách khớp FR-050; test db kiểm mọi bảng có trong danh sách.
