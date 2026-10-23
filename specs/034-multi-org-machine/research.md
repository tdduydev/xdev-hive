# Research: Một máy làm việc cho nhiều tổ chức

Mỗi mục: quyết định, lý do, phương án bị loại. **[Unverified]** là điều phải kiểm trên máy thật (task Phase 0).

## D1. Một tiến trình, N kênh

- **Quyết định**: giữ `instancelock` (`~/.xdev-hive/worker.lock`). Một `hive-worker` mở một `channel` cho mỗi đăng ký.
- **Lý do**: slot chung `M` và quota tài khoản AI phải đếm ở một chỗ. `accounts.Pool` hiện giữ bộ đếm trong bộ nhớ.
- **Loại**: N tiến trình, mỗi tiến trình một `--config`. Cần khoá chéo tiến trình cho quota và slot; `instancelock`
  hiện chặn tiến trình thứ hai dù khác `--config`.

## D2. Chỉ mục và bố cục thư mục

- **Quyết định**: `UserConfigDir/xdev-hive/registrations.json` là chỉ mục. Đăng ký cũ trỏ tới đường dẫn hiện có. Đăng ký
  mới có `…/xdev-hive/orgs/<id>/` cho cấu hình và `UserCacheDir/xdev-hive/worker/orgs/<id>/` cho dữ liệu.
- **Lý do**: không chuyển file khi nâng cấp, nên rollback an toàn (FR-081). Bản cũ không đọc chỉ mục.
- **Loại**: chuyển `worker.json` vào `orgs/<id>/` lúc nâng cấp. Bản cũ sẽ không tìm thấy cấu hình.
- **Id đăng ký**: `reg_` + 8 ký tự base32 ngẫu nhiên. Không dùng orgId để tên thư mục không lộ tổ chức cho người xem
  ổ đĩa và không trùng khi đăng ký lại.

## D3. Đường dẫn chung hiện có và quyết định cho từng cái

| Đường dẫn | Gói | Quyết định |
|---|---|---|
| `UserConfigDir/xdev-hive/worker.json` | config | Đăng ký cũ |
| `projects.json`, `remote.json`, `gitgroups.json` cạnh `worker.json` | projects, remoteauth, gitgroups | Theo đăng ký (cạnh `worker.json` của đăng ký) |
| `accounts.json` cạnh `worker.json` | accounts | **Theo máy**: một file ở đường dẫn của đăng ký cũ; thêm trường `registrations` |
| `UserCacheDir/xdev-hive/worker` (repos, worktrees, pending, active, terminal, guard, codegraph) | repolock, channel | Theo đăng ký |
| `~/.xdev-hive/outbox/<identity>` | outbox (027) | Đã theo danh tính; giữ |
| `~/.xdev-hive/memory/claude` (bộ nhớ chung giữa gói) | memstore | Theo đăng ký: `~/.xdev-hive/memory/<reg>/claude`; đăng ký cũ giữ đường dẫn cũ |
| `~/.xdev-hive/context` | ctxsync | Theo đăng ký |
| `~/.xdev-hive/optimizer` | optimizer | Theo tài khoản (đã vậy); trạng thái chung chỉ có số liệu, không dữ liệu tổ chức **[Unverified]** |
| `~/.xdev-hive/hub-ca.pem` | hubtls | Theo đăng ký khi hai hub khác CA; mặc định đọc file chung rồi file của đăng ký |
| `~/.xdev-hive/accounts/<id>` | accounts | Thư mục đăng nhập của gói; trạng thái CLI tách ra (D4) |
| Socket `UserConfigDir/xdev-hive/run/hive.sock` | localipc | Một socket; lệnh mang mã phiên run (D6) |
| Kho bí mật 031 (`secrets.json`, `secrets-policy.json`) | secretstore | Theo đăng ký, cộng phạm vi "riêng trên máy" |

## D4. Tách trạng thái CLI khỏi đăng nhập

- **Quyết định**: thư mục trạng thái `~/.xdev-hive/cli-state/<account>/<reg>/` là `CLAUDE_CONFIG_DIR` (hay `CODEX_HOME`) của
  run. Worker tạo liên kết từ file đăng nhập của gói vào đó: Claude `.credentials.json` (Linux, Windows), Codex
  `auth.json`. Skill, memory, `settings.json`, MCP, plugin, `projects/`, lịch sử là của thư mục đó.
- **macOS, Claude**: đăng nhập nằm trong Keychain, mục đặt theo băm của đường dẫn thư mục cấu hình **[Unverified]**.
  Thư mục khác thì mất đăng nhập. Phương án theo thứ tự: (a) đặt `CLAUDE_CODE_OAUTH_TOKEN` từ token của gói nếu gói đó
  dùng token (đã có `tokenEnv` trong `accounts.go`); (b) giữ `CLAUDE_CONFIG_DIR` của gói và chuyển các thư mục con
  trạng thái thành liên kết tới thư mục của đăng ký trước mỗi run, khoá theo gói; (c) FR-041 câu cuối: gói chỉ gán một
  đăng ký. T001 chọn.
- **Loại**: chép cả thư mục cấu hình cho mỗi đăng ký. Đăng nhập lại hết hạn ở một bản, bản kia hỏng.

## D5. Lập lịch

- **Quyết định**: scheduler giữ `running[r]`, `M`, `L(r)`, `w(r)`. Một đề nghị của r được nhận khi
  `running[r] < L(r)` và `sum(running) < M`. Khi máy đầy mà có đăng ký khác đang chờ, đăng ký có `running[r]/w(r)` lớn
  nhất nhả trước ở lần chọn sau (không huỷ run đang chạy). Đăng ký đang có việc chờ được ghi khi nhận đề nghị mà phải
  từ chối; heartbeat kế báo `load` của từng kênh.
- **`machine_busy`**: worker từ chối với lý do `machine_busy` khi chỉ thiếu slot chung. Hub không thêm máy vào
  `rejectedBy`, đánh dấu máy "bận" trong bộ nhớ tới heartbeat kế (tối đa 30 giây), rồi thử máy khác.
- **Giữ chỗ công bằng**: khi `running[r] < fair(r)` và máy đầy, worker giảm `capacity` báo các hub khác ở heartbeat kế
  để hub đó không đề nghị thêm. Không cần giao thức mới: `hello.capacity` đã có; heartbeat chưa mang `capacity`, nên
  T042 thêm trường tuỳ chọn `capacity` vào heartbeat **[027]** (`worker-protocol.ts` đang khoá).
- **Loại**: hàng chờ chung trên máy. Máy phải nhận việc rồi giữ, trái lease của hub.

## D6. Socket cục bộ và lệnh `hive` từ trong run

- **Quyết định**: lúc tạo run, worker sinh `HIVE_RUN_SESSION` (32 byte ngẫu nhiên) chỉ có trong env của run và agent
  con. Lệnh ghi qua socket gửi mã này; worker tra bảng mã → (đăng ký, run). Máy có từ hai đăng ký mà thiếu mã thì từ
  chối lệnh ghi. Lệnh từ desktop dùng mã phiên desktop do app giữ, kèm id đăng ký.
- **Giới hạn**: tiến trình cùng người dùng đọc được env của run khác (`/proc/<pid>/environ` trên Linux cùng UID). Đây là
  phần của giới hạn mức `chung-người-dùng` (spec US3).

## D7. Chính sách theo đăng ký

- **Quyết định**: chính sách đã biết (`welcome.policy`) lưu trong thư mục đăng ký. Điều khoản mới
  `aiAccountSharing`, `machineIsolation` áp ở máy. Hub chỉ gửi xuống, không biết kết quả trừ cờ `policy_unmet`.

## D8. Keychain desktop

- **Quyết định**: tài khoản keychain `"<hub>#<orgId>"` trong dịch vụ `dev.xdev.hive`. Lần đầu đọc khoá cũ `"<hub>"`, lấy
  orgId từ token (`hive_pat_<orgId>_…`), ghi khoá mới, xoá khoá cũ.

## D9. Sandbox đọc (FR-024)

- **Linux**: Landlock ABI ≥ 1 (kernel 5.13+): cho đọc toàn hệ thống trừ thư mục đăng ký khác **[Unverified]** — Landlock
  là danh sách cho phép, không có "trừ". Phương án: cho phép rõ `/usr`, `/etc`, `/tmp`, home trừ các thư mục
  `xdev-hive/orgs/*` khác. T003 kiểm khả thi.
- **macOS**: `sandbox-exec` với profile `(deny file-read* (subpath "<thư mục đăng ký khác>"))`. API đã cũ nhưng vẫn chạy
  **[Unverified]**.
- **Windows**: không có ở mức này. Ghi rõ.

## D10. Phân quyền hub

Chi tiết ở rbac-review.md. Các quyết định:

- Hội thoại Leader: hiện cho người có vai trò trong đội của dự án; không gắn dự án thì người tạo và owner/admin tổ chức.
- Token cá nhân: tổ chức được chọn phải trùng tổ chức của token; kiểm ở middleware `inOrg`/`orgMember` bằng một trường
  thêm vào phiên giả lập (`session.tokenOrgId`).
- Đăng ký lại cùng tên: kiểm người tạo mã; giữ chủ cũ.
- Router fleet: thêm `requireOrgRole(member)` trong `inOrg` của nó.
- Chủ máy cá nhân: tự tạm dừng, tiếp tục, thu hồi.
