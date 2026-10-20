# Quản lý nhánh Git trong app desktop

Hướng dẫn dùng cho màn **Dự án trên máy** của app desktop. Spec: [026](../specs/026-desktop-git-branches/spec.md). Hợp
đồng giữa giao diện, Rust và worker: [branches-cli.md](../specs/026-desktop-git-branches/contracts/branches-cli.md).
Yêu cầu: mục 3.27 của [srs.md](srs.md). Thiết kế: mục 5.1 của [architecture.md](architecture.md).

Mọi thao tác chạy tại máy bằng `git` của máy. Không cần đăng nhập Hive và app không gửi dữ liệu nhánh nào lên hub. App
dùng credential helper và khoá SSH của máy như khi bạn gõ `git fetch` trong terminal.

## 1. Mở bảng nhánh

Màn **Dự án trên máy** hiện cho mỗi repo nhánh đang đứng (hay "HEAD rời"), trạng thái sạch hay có thay đổi, và số commit
trước/sau upstream. Số này đọc từ ref đã có trên máy, không gọi mạng. Bấm **Nhánh** ở dòng repo để mở bảng nhánh.

Bảng nhánh có ba tab:

| Tab | Nội dung |
|---|---|
| Local | Nhánh local, nhánh đang đứng ở đầu, còn lại mới commit trước |
| Remote | Nhánh chỉ có trên remote, chưa có bản local |
| Worktree | Thư mục chính và các worktree liên kết, kèm trạng thái từng thư mục |

- Ô **Lọc theo tên** lọc theo tên nhánh hoặc thư mục.
- Mỗi nhánh hiện số commit trước/sau upstream, so với nhánh mặc định, số commit chưa đẩy lên remote nào và worktree đang
  mở nhánh đó. "Remote đã xoá" nghĩa là upstream đã biến mất sau `fetch --prune`.
- Worktree hiện "Sạch", "Có thay đổi", "Có file chưa theo dõi", "Thư mục đã mất", "Bị khoá". Nhãn "Worker đang dùng",
  "Đang có agent", "Đang có terminal", "App đang dùng" cho biết có chương trình đang dùng thư mục đó.
- Repo đang dở merge, rebase, cherry-pick, revert hay bisect hiện nhãn "Đang dở".
- Git trên máy cũ hơn 2.41 vẫn dùng được. Khi đó số commit trước/sau nhánh mặc định chỉ có ở nhánh khớp mẫu dọn.

Nút **Fetch** chạy `fetch --prune` cho từng remote của repo và ghi remote nào lỗi. **Đọc lại** đọc lại ref trên máy,
không gọi mạng.

## 2. Đổi nhánh

Chọn menu của một nhánh, rồi **Đổi sang nhánh này**. Nhánh chỉ có trên remote được tạo bản local theo dõi remote đó.

- Thư mục có thay đổi đã theo dõi thì hộp thoại liệt kê file đang sửa. Chọn **Huỷ** hoặc **Đổi, mang thay đổi theo**.
  Nếu thay đổi đụng file khác nhau giữa hai nhánh, git từ chối và thư mục giữ nguyên. App không stash.
- File chưa theo dõi không làm hộp thoại hiện. Git chỉ từ chối khi việc đổi sẽ ghi đè chúng.
- Thư mục đang có agent, terminal hay đang là thư mục của cửa sổ app thì hộp thoại hỏi xác nhận thêm.
- Repo đang dở merge, rebase, cherry-pick, revert hay bisect thì không đổi được. Hoàn tất hay huỷ thao tác dở trước.

## 3. Tạo nhánh

**Tạo nhánh** mở hộp thoại: tên nhánh, nhánh gốc (local hoặc remote), tuỳ chọn **Fetch nhánh gốc trước** và **Đổi sang
nhánh mới sau khi tạo**.

- App kiểm tên bằng `git check-ref-format --branch` và báo ngay nếu nhánh đã có. App không bao giờ ghi đè nhánh có sẵn.
- Nhánh mới không có upstream. Đẩy lên remote là việc của bạn, app không push.
- Fetch lỗi thì hộp thoại hỏi có tạo từ bản đã có trên máy không.

## 4. Pull, merge, rebase

**Pull** chỉ tiến nhanh (`merge --ff-only`) từ upstream của nhánh đang đứng. Nút tắt kèm lý do khi HEAD rời, repo đang
dở thao tác, hoặc nhánh không có hay mất upstream. Thư mục có thay đổi hay file chưa theo dõi thì Pull dừng và liệt kê.
Hai nhánh đã rẽ nhau (`diverged`) thì hộp thoại đề nghị **Merge upstream** hoặc **Rebase lên upstream**.

Trong menu của một nhánh khác:

- **Merge vào nhánh đang đứng**: `git merge --no-ff --no-edit`, luôn tạo merge commit.
- **Merge vào nhánh đang đứng, cho phép tiến nhanh**: `git merge --no-edit`; nếu nhánh đang đứng chưa rẽ nhánh thì git
  chỉ dời nhánh lên, không tạo merge commit. Mục này tắt khi HEAD đang tách rời.
- **Rebase nhánh đang đứng lên nhánh này**: nếu nhánh đang đứng có commit đã nằm trên ref remote nào đó thì app hỏi thêm,
  vì rebase viết lại lịch sử.
- Dòng nhánh đang đứng có lối tắt **Cập nhật từ \<nhánh mặc định\>**.

Điều kiện chung: thư mục sạch (cả file chưa theo dõi), đang đứng trên một nhánh, không có thao tác dở. App không stash và
dừng lệnh sau 120 giây mà không tự huỷ.

### Khi có xung đột

Git dừng, bảng nhánh hiện khung **Đang merge** hay **Đang rebase** ở đầu: bước n/m với rebase, danh sách file xung đột
(tối đa 200). App không tự sửa file. Bạn sửa file ở IDE, hay bấm **Mở thư mục** hoặc **Mở terminal**, rồi `git add` file
đã xử lý. Sau đó:

- **Tiếp tục** chạy `--continue` với thông điệp commit có sẵn. Còn file xung đột chưa `add` thì app không chạy lệnh.
- **Huỷ** (có hỏi lại) chạy `--abort`, thư mục về như trước khi bắt đầu.

App không có `rebase --skip`, `merge --quit`, `rebase --quit`. Dùng terminal nếu cần.

## 5. Dọn nhánh

Nút **Dọn nhánh** ở đầu màn quét mọi repo trên máy. Menu của một nhánh có **Dọn nhánh repo này** để quét một repo. App
chỉ dọn khi bạn bấm, luôn qua xem trước và xác nhận. Không có dọn tự động.

### 5.1. Nhánh nào là ứng viên

Một nhánh là ứng viên khi **đồng thời**:

1. Tên khớp **mẫu dọn**. Mặc định `ai/*` và `claude/*`. Nhánh khác vẫn hiện trong bảng nhánh nhưng không được đề xuất.
2. Có bằng chứng đã merge:
   - đã vào nhánh mặc định của remote qua merge commit (chỉ cần git);
   - hoặc PR/MR đã merge theo API GitHub/GitLab, khi repo có kết nối Git tại máy (spec 016) trùng máy chủ của `origin`.
     Cách này nhận cả PR squash-merge.
3. Không có commit chưa đẩy lên remote nào đã fetch được.
4. Không bị chặn (mục 5.2).

Nhánh có PR/MR **đã đóng không merge** là ứng viên chỉ khi nhánh cùng tên còn trên remote và chứa đỉnh nhánh local. Mục
này **mặc định không chọn**, và app kiểm lại bằng `git ls-remote` ngay trước khi xoá.

Không bao giờ là ứng viên: nhánh mặc định, nhánh đang đứng ở thư mục chính, nhánh có PR/MR đang mở.

Nếu remote không fetch được, app chỉ nhận ứng viên mà đỉnh đã nằm trong nhánh mặc định của remote theo ref có sẵn. Mục
còn lại hiện "Cần fetch được để kiểm".

### 5.2. Mục bị chặn

Mục bị chặn nằm ở nhóm **Không dọn**, kèm lý do:

| Lý do | Ý nghĩa |
|---|---|
| Của worker Hive | Worktree dưới thư mục dữ liệu của worker (`runs/`, `terminals/`). Không bao giờ đụng tới |
| Đang có chương trình dùng | Có agent, terminal hay cửa sổ app ở trong worktree |
| Có file đã sửa, file chưa theo dõi | Worktree không sạch |
| File bị bỏ qua không dựng lại được | Ví dụ `.env` tạo tay. `git worktree remove` xoá cả file bị bỏ qua, nên app chặn (liệt kê tối đa 20 file) |
| Worktree đang bị khoá, không truy cập được | `git worktree lock`, ổ chưa gắn |
| Có submodule | Worktree có submodule đã init (có `modules/` trong thư mục git của worktree, hoặc gitlink có `.git`). `git worktree remove` cũng từ chối các worktree này. Submodule chưa init không chặn |
| Có commit chưa đẩy | Không bao giờ xoá |
| PR/MR đang mở | |
| Nhánh đang mở ở thư mục chính | Xem gợi ý bên dưới |

Thư mục chính đang đứng ở nhánh đã merge thì xem trước gợi ý **Về nhánh mặc định**. Nút chỉ bật khi thư mục sạch và không
dở thao tác. Bạn bấm riêng, rồi quét lại. App không tự đổi nhánh trong lượt dọn.

Thư mục dựng lại được (mặc định `node_modules`, `dist`, `build`, `target`, `.turbo`, `.next`, `.venv`, `__pycache__`,
`coverage`) là file bị bỏ qua mà app cho phép mất theo worktree.

### 5.3. Xem trước, xác nhận, kết quả

Xem trước chia theo repo, mỗi mục ghi bằng chứng ("Đã vào main qua merge commit", "PR #N đã merge", "MR !N đã merge"),
ngày commit cuối và worktree đi kèm. Chọn mục rồi bấm **Dọn N mục**. Hộp xác nhận ghi số nhánh local sẽ xoá và số
worktree sẽ gỡ.

Với mỗi mục, theo thứ tự: kiểm lại mọi điều kiện và mã đỉnh nhánh, **gỡ worktree trước** bằng `git worktree remove`
(không `--force`), **xoá nhánh sau** bằng `git branch -D`. Gỡ worktree dở hay lỗi thì giữ nhánh. Nếu trạng thái đổi giữa
lúc xem trước và lúc dọn (có commit mới, file mới, agent mới), mục đó bị bỏ qua. Các mục khác vẫn chạy.

App **không bao giờ** xoá nhánh trên remote và không push. Worktree có thư mục đã mất (`prunable`) chỉ bị gỡ đăng ký, không
xoá file. Bấm **Huỷ** khi đang dọn: mục đang chạy chạy hết, các mục sau ghi "Chưa chạy".

Kết quả mỗi mục là **Đã dọn**, **Bỏ qua**, **Dở dang** hoặc **Lỗi**, kèm lý do. Mục đã dọn có **Lệnh khôi phục**. Có nút
**Sao chép mọi lệnh khôi phục**.

### 5.4. Cấu hình

Mục **Mẫu dọn và thư mục dựng lại được** trong hộp thoại sửa hai danh sách trên, rồi **Lưu và quét lại**. Mẫu là glob
đơn giản, `*` khớp mọi ký tự kể cả `/`. **Về mặc định** đặt lại. Cấu hình lưu ở `branches.json` cạnh `worker.json` trong
thư mục cấu hình của app.

## 6. Khôi phục từ nhật ký

Mỗi thao tác ghi (dọn, đổi, tạo nhánh, pull, merge, rebase, tiếp tục, huỷ) thêm một dòng JSON vào
`branches-log.jsonl` trong thư mục cấu hình của app, cạnh `worker.json`:

- macOS: `~/Library/Application Support/xdev-hive/`
- Windows: `%AppData%\xdev-hive\`
- Linux: `~/.config/xdev-hive/`

File giữ 1.000 dòng gần nhất. Dòng chỉ có thời điểm, repo, nhánh, mã commit và đường dẫn. Không có token hay nội dung
file. Lệnh đọc không ghi.

**Khôi phục nhánh đã dọn.** Tìm dòng `"action":"clean"` của nhánh, lấy `tip` (hay trường `restore`), rồi trong repo:

```sh
git branch <tên-nhánh> <tip>
```

Nhánh về lại như lúc dọn. Worktree đã gỡ thì tạo lại bằng `git worktree add <thư-mục> <tên-nhánh>`. File bị bỏ qua đã mất
theo worktree (như `node_modules`) phải dựng lại. Commit chỉ còn trong nhánh đó cũng chỉ còn lấy lại được khi git chưa dọn
rác, nên khôi phục sớm. App không xoá nhánh có commit chưa đẩy, nên thường commit vẫn còn trên remote.

**Quay về trước một lần merge hay rebase.** Dòng `"action":"merge"` hoặc `"rebase"` có `headBefore`. App hiện sẵn lệnh
sau khi xong, và không tự chạy:

```sh
git reset --keep <headBefore>
```

`--keep` giữ thay đổi chưa commit và từ chối nếu sẽ mất file. Dùng khi thư mục sạch.

## 7. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| "Không fetch được" hay "Không đăng nhập được remote" | Chạy `git fetch` trong terminal để kiểm credential. App không hỏi mật khẩu (`GIT_TERMINAL_PROMPT=0`) |
| "Không đọc được PR/MR" | Kiểm token của kết nối Git ở nhóm Git. Bằng chứng git vẫn dùng được |
| "Repo đang bận, thử lại sau" | Worker đang giữ khoá repo. Thử lại sau vài giây |
| Mục dọn "Nhánh đã đổi sau khi xem trước" | Quét lại. Đây là kiểm an toàn, không phải lỗi |
| Nút Pull tắt | Đọc dòng "Pull không chạy được: …" ngay dưới nút |

## 8. Giới hạn đã biết

- **Submodule.** Chỉ chặn worktree có submodule đã init (T020). Không đọc được trạng thái submodule chắc chắn thì app
  vẫn chặn.
- **SC-004** (số worktree liên kết giảm sau khi dọn): đạt sau T020 trên bản sao repo A (28 xuống 8 worktree liên kết;
  còn lại đúng worktree bẩn, có commit chưa merge và mới tạo). Đo trên macOS, chưa đo trên Windows, chưa chạy trên
  repo thật. Số đo ở [research.md mục 5.5](../specs/026-desktop-git-branches/research.md).
- **Hiệu năng.** Trên macOS, bảng nhánh hiện sau khoảng 1,1–1,5 giây với 29–30 worktree và hơn 460 nhánh. Trạng thái đủ
  của mọi worktree xong sau khoảng 3–4,5 giây, nên bảng hiện dần. Chưa đo trên Windows.
- **Huy hiệu số nhánh dọn được** ở nút Dọn nhánh (T017). Số lấy từ lần quét gần nhất: sau khi fetch, sau khi dọn hoặc
  bấm Làm mới. Mở màn Dự án chưa tự quét, nên huy hiệu trống tới lần fetch đầu. Fetch từ nhóm Git cũng chưa quét lại.
  Số bằng 0 thì ẩn. Huy hiệu chỉ đếm, không bao giờ tự xoá.
- Kho bare trong bộ nhớ đệm của worker không được quét. Nhánh trên remote không bao giờ bị xoá.
