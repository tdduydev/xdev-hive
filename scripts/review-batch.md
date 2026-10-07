# Ghép một lô để review

Chạy từ repo có các nhánh task. Script tạo branch và worktree mới, giữ nguyên checkout đang đứng và base; không pull base, push, merge vào main hay phát hành.

```bash
node scripts/review-batch.mjs --name 0142 --base main ai/R-59a ai/R-59b
node scripts/review-batch.mjs --name 0142-remote ai/R-59g 'runner:~/src/hive#ai/R-59f'
node scripts/review-batch.mjs --name 0142-gate --gate --only login,setup ai/R-59a
```

`--name` bắt buộc. Base mặc định là `main` tại máy này; hãy fetch/cập nhật base trước nếu cần. Worktree mặc định nằm cạnh repo, tên `review-<name>`; đổi bằng `--worktree <đường dẫn mới ngoài checkout>`. Branch là `review/<name>`. Script từ chối dùng lại branch hay đường dẫn đã có, để không ghi đè phiên review trước.

Nguồn là `ai/<task>` ở máy này hoặc `host:path#branch` qua SSH (dùng cấu hình SSH/Git hiện có; nhánh từ máy khác không bắt buộc có tiền tố `ai/`). Nhánh từ máy khác được fetch vào ref tạm riêng rồi xoá ref khi kết thúc, không ghi đè nhánh `ai/…` ở máy này hay `FETCH_HEAD`. SHA của base và mọi nguồn được chốt trước khi merge. Số commit tụt sau base là `git rev-list --count <source>..<base>`, không tính các merge trong lô.

Script merge theo thứ tự đầu vào, dùng `--no-ff`. Xung đột: in tên file và đoạn có marker kèm số dòng, lưu lại rồi abort merge và thử nguồn tiếp theo. File nhị phân hay xung đột xoá/đổi tên không có marker thì in các stage chưa merge của Git. Merge thành công: cài dependencies bằng `npm ci --prefer-offline` rồi chạy `npm run typecheck`. Chỉ cài lại khi manifest thay đổi. Lỗi cài dependencies hoặc typecheck: rollback merge trong worktree review và tiếp tục nguồn sau. Worktree review và các merge đã kiểm qua được giữ lại để người merge xem diff và sửa tiếp.

`--gate` chạy lần lượt và dừng tại lệnh lỗi đầu tiên, tương đương nối các lệnh bằng `&&`:

1. `npm run typecheck`
2. `npm test`
3. `npm run e2e -w @xdev-hive/web -- <thư mục ảnh web>`
4. `npm run e2e:mobile -w @xdev-hive/web -- <thư mục ảnh mobile>`
5. `npm run build -w @xdev-hive/desktop`
6. `npm run smoke -w @xdev-hive/desktop -- <thư mục ảnh desktop>`

`--only <bước>[,<bước>…]` yêu cầu `--gate` và được truyền nguyên danh sách xuống cả hai lệnh e2e; cần phiên bản e2e đã hỗ trợ 58d. Các cổng kiểm còn lại vẫn chạy đầy đủ. Trên Linux, lệnh giao diện có `ELECTRON_DISABLE_SANDBOX=1`; nếu không có `DISPLAY`, script dùng `xvfb-run -a -s "-screen 0 1440x900x24"` (cần cài xvfb).

Log của từng fetch/merge/cài dependencies/typecheck/bước gate, đoạn xung đột và `report.json` nằm trong `<worktree>/.xdev-hive/artifacts/review-batch/`, cùng thư mục ảnh. Cuối lệnh có bảng nguồn đã vào/bị bỏ qua, lý do và số commit tụt sau base. Gate vẫn kiểm các nhánh đã vào nếu có nguồn bị bỏ qua, nhưng toàn bộ lệnh trả mã lỗi để lô thiếu nhánh không bị coi là hoàn tất.

- Exit `0`: mọi nguồn đã vào, mọi cổng được yêu cầu đã qua.
- Exit `1`: có nguồn bị bỏ qua hoặc gate lỗi.
- Exit `2`: lỗi tham số, tạo worktree hoặc lỗi hạ tầng khiến không thể tiếp tục; xem `report.json` nếu đã tạo worktree.

Repo cần có Node/npm, lockfile và danh tính Git để tạo merge commit. npm scripts chạy từ code của các nhánh được chọn như khi ghép lô bằng tay. Nếu bị ngắt giữa chừng, worktree được giữ để kiểm tra; dùng một `--name` mới cho lần chạy tiếp. Xoá worktree bằng `git worktree remove <đường dẫn>` sau khi đã giữ lại báo cáo cần dùng.

Kiểm thử script độc lập (Git thật trong repo tạm, npm/SSH giả, không gọi hub hay CLI agent):

```bash
node --test scripts/test/review-batch.test.ts
```
