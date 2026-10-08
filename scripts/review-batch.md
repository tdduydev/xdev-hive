# Ghép một lô để review

Chạy từ repo có các nhánh task. Script tạo branch và worktree mới, giữ nguyên checkout đang đứng và base; không pull base, push, merge vào main hay phát hành.

```bash
node scripts/review-batch.mjs --name 0142 --base main ai/R-59a ai/R-59b
node scripts/review-batch.mjs --name 0142-remote ai/R-59g 'runner:~/src/hive#ai/R-59f'
node scripts/review-batch.mjs --name 0142-gate --gate --only login,setup ai/R-59a
node scripts/review-batch.mjs --name 0142-preview --gate --preview --preview-ttl 30 ai/R-59a
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

`--preview` yêu cầu `--gate` và terminal tương tác trên macOS/Linux. Chỉ khi mọi nguồn đã vào và toàn bộ gate xanh, script mới dựng hub web từ **SHA đầy đủ của lô đã kiểm** trong một detached worktree tạm. Cài dependencies và build lại ở đó; không dùng bản build của checkout đang đứng. Gate đổi HEAD hoặc file đã theo dõi bị coi là lỗi.

Preview chỉ lắng nghe `127.0.0.1`, có DB và backup tạm riêng, không nhận biến môi trường HIVE hay credential sản xuất. Terminal hiện URL, SHA và đường dẫn `login.txt` (chỉ chủ tài khoản hệ điều hành đọc được). Đọc token trong terminal riêng rồi đăng nhập ứng dụng bằng token đó. Không đưa token vào báo cáo/artifact. Phiên này dành cho người review trên chính máy chạy lệnh; không mở cổng LAN hay chia sẻ public.

Sau khi xem ứng dụng, nhập đúng SHA đầy đủ ở terminal để duyệt; nhập giá trị khác để từ chối. Script kiểm lại SHA của branch review, SHA base/target, HEAD/file của preview và gate trước khi ghi receipt. Branch hay target đổi trong lúc xem thì receipt không được duyệt: chạy lại lô với tên mới. `--preview-ttl` từ 1 đến 120 phút, mặc định 30, tính cả thời gian cài/build. Hết TTL, Ctrl-C, SIGHUP hoặc SIGTERM dừng nhóm tiến trình và xoá worktree, DB, token tạm. Receipt không chứa token, được ghi vào `report.json` với `sha`, `gateSha`, `baseSha`, thời hạn và thời điểm duyệt. Từ chối preview trả exit 1; stale/timeout/startup lỗi trả exit 2. Receipt là bằng chứng review tại máy, không tự cho phép merge, push hay phát hành trên hub.

Checkout preview là clone local riêng (copy object, bỏ remote, checkout detached), để không ghi vào `.git` dùng chung của repo nguồn. Preview chạy code của nhánh như các lệnh gate, với quyền tài khoản chạy script; checkout riêng không phải sandbox cho code không tin cậy. Không dùng quy trình này để chạy nhánh từ người không được tin cậy. SIGKILL hoặc máy mất điện không thể chạy cleanup; nếu gặp, xoá thư mục phiên tạm `hive-preview-*` sau khi bảo đảm không còn process của phiên.

Log của từng fetch/merge/cài dependencies/typecheck/bước gate, đoạn xung đột và `report.json` nằm trong `<worktree>/.xdev-hive/artifacts/review-batch/`, cùng thư mục ảnh. Cuối lệnh có bảng nguồn đã vào/bị bỏ qua, lý do và số commit tụt sau base. Gate vẫn kiểm các nhánh đã vào nếu có nguồn bị bỏ qua, nhưng toàn bộ lệnh trả mã lỗi để lô thiếu nhánh không bị coi là hoàn tất.

- Exit `0`: mọi nguồn đã vào, mọi cổng được yêu cầu đã qua.
- Exit `1`: có nguồn bị bỏ qua hoặc gate lỗi.
- Exit `2`: lỗi tham số, tạo worktree hoặc lỗi hạ tầng khiến không thể tiếp tục; xem `report.json` nếu đã tạo worktree.

Repo cần có Node/npm, lockfile và danh tính Git để tạo merge commit. npm scripts chạy từ code của các nhánh được chọn như khi ghép lô bằng tay. Nếu bị ngắt giữa chừng, worktree được giữ để kiểm tra; dùng một `--name` mới cho lần chạy tiếp. Xoá worktree bằng `git worktree remove <đường dẫn>` sau khi đã giữ lại báo cáo cần dùng.

Kiểm thử script độc lập (Git thật trong repo tạm, npm/SSH giả, không gọi hub hay CLI agent):

```bash
node --test scripts/test/review-batch.test.ts
```
