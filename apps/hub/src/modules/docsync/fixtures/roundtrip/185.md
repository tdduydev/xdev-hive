# Feature Specification: Clone và pull theo group GitLab, org GitHub trong app desktop

**Feature Branch**: `ai/desktop-git-group-sync`

**Created**: 2026-10-14

**Status**: Draft (chờ product owner xem)

**Input**: Người dùng (2026-10-14): "phần dự án trên máy chưa có quản lý pull theo groups GitLab".

## Phạm vi

- Màn **Dự án trên máy** của app desktop có thêm mục **Nhóm Git theo dõi**. Mục này chạy được **không cần đăng nhập
  Hive** (app desktop là client; tính năng tại máy không chặn sau đăng nhập).
- Git chạy bằng `git` của máy, qua sidecar `hive-worker gitgroups`. Không tự viết giao thức git.
- Không đổi cách worker chạy run. Repo clone xong chỉ được thêm vào `projects.json` dạng "chưa có dự án trên hub".

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Kết nối Git tại máy | Một máy chủ GitLab (gitlab.com hoặc tự host) hay GitHub (github.com hoặc Enterprise) kèm personal access token của người dùng. |
| Nhóm theo dõi | Một group GitLab (gồm subgroup) hoặc một org/tài khoản GitHub, một thư mục gốc, cách clone (HTTPS hay SSH) và bộ lọc. |
| Đường dẫn repo | `<gốc>/<đường dẫn đầy đủ của repo>`, vd `<gốc>/acme/payments/api`. |

## User Scenarios & Testing

### US1 - Thêm kết nối Git tại máy (P1)

Người dùng chọn loại (GitLab/GitHub), nhập URL máy chủ (để trống là gitlab.com/github.com), tên gợi nhớ và token. App
gọi API kiểm token (`/api/v4/user`, `/user`) rồi mới lưu.

1. **Given** token đúng, **When** thêm, **Then** token nằm trong keychain của hệ điều hành (dịch vụ `dev.xdev.hive.git`,
   khoá là id kết nối). File cấu hình chỉ có loại, URL, tên, tên đăng nhập. Token không bao giờ về giao diện, không vào
   log, không vào tham số dòng lệnh.
2. **Given** token sai, **When** thêm, **Then** báo "Token không dùng được…" và không lưu gì.
3. **Given** đã đăng nhập Hive và tổ chức có kết nối Git, **When** mở form, **Then** có thể chọn một kết nối của tổ chức
   để điền sẵn loại, URL và group mặc định. Token vẫn là token cá nhân: hub không gửi secret của tổ chức xuống máy.
4. **Given** kết nối còn nhóm dùng, **When** xoá, **Then** từ chối và nêu tên nhóm.

### US2 - Thêm nhóm theo dõi (P1)

Người dùng chọn kết nối, gõ đường dẫn group (có gợi ý từ API: group mình là thành viên, org của mình), chọn thư mục gốc
và cách clone.

1. GitLab: lấy `GET /api/v4/groups/:path/projects?include_subgroups=true` theo trang (100 mục/trang, theo
   `X-Next-Page` hoặc `Link`). GitHub: `GET /orgs/:org/repos`, 404 thì thử `/users/:user/repos`, theo `Link: rel="next"`.
2. Danh sách repo lưu lại (đường dẫn, nhánh mặc định, archived, URL clone) để màn hình hiện không cần mạng. Nút
   **Cập nhật danh sách** đọc lại API.
3. Lọc: mặc định bỏ repo archived; lọc theo regex trên đường dẫn đầy đủ; chọn/bỏ từng repo. Repo mới xuất hiện trong group
   mặc định được chọn.
4. Đường dẫn từ API được kiểm từng đoạn: không `..`, không ký tự cấm của Windows, không tên dành riêng (`CON`, `NUL`…),
   không đi ra ngoài thư mục gốc. Repo có đường dẫn hỏng hiện trạng thái lỗi, không clone.

### US3 - Trạng thái và thao tác hàng loạt (P1)

Trạng thái mỗi repo, đọc bằng `git status --porcelain=v2 --branch` (không gọi mạng):

| Trạng thái | Điều kiện |
|---|---|
| Chưa clone | Thư mục chưa có |
| Sạch | Đúng nhánh mặc định, không thay đổi, không ahead/behind |
| Có thay đổi | Có file đã theo dõi bị sửa, đã stage hoặc xung đột. File chưa theo dõi không tính: `pull --ff-only` tự dừng an toàn nếu sẽ ghi đè |
| Ahead | Có commit chưa đẩy |
| Behind | Thiếu commit của remote |
| Lệch | Đang ở nhánh khác nhánh mặc định, HEAD rời, hoặc vừa ahead vừa behind |
| Lỗi | Thư mục có mà không phải repo, origin là repo khác, git lỗi |

Thao tác: **Clone thiếu**, **Fetch**, **Pull tất cả**, mở thư mục, mở terminal.

1. Pull = `fetch --prune` rồi tiến nhánh nhanh (`merge --ff-only @{u}`, tương đương `pull --ff-only` mà không gọi mạng lần
   hai) chỉ khi repo đang Behind. Có thay đổi, Lệch, Lỗi thì **bỏ qua** và báo lý do. Không stash, không reset, không
   tạo merge commit.
2. Chạy song song tối đa 4 repo, hiện tiến độ từng repo và tổng; nút **Huỷ** dừng git đang chạy và không bắt đầu repo mới.
3. Clone xong thì repo vào `projects.json` (mục chưa gắn dự án), nên hiện trong danh sách Dự án trên máy.
4. Credential: HTTPS dùng `GIT_ASKPASS` trỏ chính `hive-worker` (đọc token từ biến môi trường của tiến trình con),
   `credential.helper` để rỗng để không đọc, không ghi credential của máy; URL clone không chứa token. SSH dùng khoá của
   máy.

### US4 - Tự fetch định kỳ (P3)

Mỗi nhóm có tuỳ chọn tự fetch mỗi N phút, **tắt mặc định**. App (đang chạy, kể cả chỉ ở khay) kiểm mỗi phút và chỉ fetch,
không pull.

## Yêu cầu khác

- Windows: đường dẫn ghép bằng `filepath.Join`, so khớp không phân biệt hoa thường; không đổi `core.autocrlf` của người
  dùng.
- Chữ giao diện tiếng Việt, có bản tiếng Anh như các màn khác.

## Kiểm thử

- Go: phân trang API GitLab/GitHub với server HTTP giả; kiểm đường dẫn; đọc `status --porcelain=v2`; end-to-end với bare
  repo cục bộ: clone thiếu, pull repo behind, bỏ qua repo bẩn và lệch nhánh, huỷ giữa chừng; askpass.
- Rust: tham số sidecar, tách biến môi trường token.
- Vitest: mục Nhóm Git theo dõi (thêm kết nối, hiện trạng thái, tiến độ, huỷ).

## Ngoài phạm vi

- Dùng token của kết nối tổ chức trên hub để clone (hub không gửi secret xuống client). Nếu cần, làm sau bằng API của
  hub liệt kê repo thay cho máy.
- Push, đổi nhánh, xoá repo đã clone.
