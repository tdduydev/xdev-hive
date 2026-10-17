# Feature Specification: Chuyển đăng nhập SSH từ mật khẩu sang khoá trong app desktop

**Feature Branch**: `ai/desktop-ssh-keys`
**Ngày**: 2026-10-17
**Trạng thái**: Bản nháp, chờ chủ dự án duyệt
**Input**: Người dùng (2026-10-17): "thêm tính năng quản lý ssh username pass sang ssh-key vào client".

## Vì sao làm

Đội ehospital-ai triển khai hub lên máy chủ `10.86.224.34` (user `adminvm`) bằng `deploy/remote.sh`. Script gọi `ssh`
nhiều lần. Máy dev đăng nhập máy chủ bằng mật khẩu, nên mỗi lần triển khai phải gõ mật khẩu nhiều lần, và agent không
được gõ mật khẩu thay người dùng. Máy dev của người dùng đã có `~/.ssh/id_ed25519`, nhưng máy chủ từ chối khoá đó vì
khoá công khai chưa có trong `authorized_keys`.

Chuyển sang khoá bằng tay cần nhiều bước dễ sai trên Windows: không có `ssh-copy-id`, quyền file `~/.ssh` sai thì
OpenSSH bỏ qua khoá mà không báo rõ. Người dùng muốn app desktop làm các bước này cho mọi người trong đội.

## Mục tiêu

1. Người dùng thêm một máy chủ (host, cổng, tên đăng nhập) và chuyển sang đăng nhập bằng khoá trong một lần, chỉ gõ
   mật khẩu một lần.
2. Sau khi xong, `ssh <alias>` và `ssh <user>@<host>` trong terminal đăng nhập được không cần mật khẩu, nên
   `deploy/remote.sh` chạy không hỏi mật khẩu.
3. Màn danh sách cho biết máy chủ nào đăng nhập bằng khoá được, máy chủ nào còn cần thiết lập.

## Không làm (non-goals)

- App KHÔNG tự tắt đăng nhập bằng mật khẩu trên máy chủ. App chỉ hiện hướng dẫn, sau cảnh báo và xác nhận (US5).
- Không lưu mật khẩu ở bất kỳ đâu: không keychain, không file, không log, không gửi lên hub.
- Không đồng bộ danh sách máy chủ lên hub. Tính năng chỉ ở máy này, chạy được khi chưa đăng nhập Hive.
- Không hỗ trợ máy chủ Windows (OpenSSH Server trên Windows dùng `administrators_authorized_keys` và quyền khác).
- Không hỗ trợ máy chủ chỉ vào được qua máy trung gian (`ProxyJump`, `ProxyCommand`) ở bước cài khoá. Bước kiểm tra
  vẫn dùng `ssh` của máy nên vẫn đi qua máy trung gian.
- Không gỡ khoá công khai khỏi máy chủ khi người dùng xoá một mục. App chỉ hiện hướng dẫn gỡ.
- Không quản lý ssh-agent, chứng chỉ SSH, khoá phần cứng (FIDO, `sk-`).
- Không sửa khối `Host` do người dùng tự viết trong `~/.ssh/config`.

## Điều làm tính năng thất bại (anti-goals)

- Mật khẩu xuất hiện trong log, file, tham số dòng lệnh, biến môi trường, báo lỗi, hoặc gửi tới máy khác máy chủ đã
  xác nhận.
- App gửi mật khẩu tới một máy chủ có khoá máy chủ (host key) chưa được người dùng xác nhận, hoặc khác khoá đã biết.
- App làm hỏng `~/.ssh/config` của người dùng, hoặc mất cấu hình người dùng tự viết.
- App làm người dùng mất quyền vào máy chủ.
- Sau khi app báo "xong", `ssh` trong terminal vẫn hỏi mật khẩu.

## Hiện trạng: dùng lại, mở rộng, làm mới

| Phần | Hiện có | Việc cần làm |
|---|---|---|
| Lệnh tại máy qua sidecar | `hive-worker gitgroups`, `projects`, `accounts` trả JSON; Rust kiểm tham số rồi gọi `sidecar_json` ([lib.rs](../../apps/desktop/src-tauri/src/lib.rs)) | Dùng lại cách làm: thêm `hive-worker ssh` |
| Secret đi qua sidecar | Token Git qua biến môi trường `HIVE_GIT_TOKEN` ([git_groups.rs](../../apps/desktop/src-tauri/src/git_groups.rs)) | Mật khẩu SSH đi qua stdin, không qua biến môi trường |
| DACL chỉ cho người dùng hiện tại trên Windows | `pipeSDDL` ([listen_windows.go](../../worker/internal/localipc/listen_windows.go)) | Dùng lại cách làm cho file khoá riêng |
| Menu app | `NAV_GROUPS` ([nav.ts](../../apps/desktop/src/lib/nav.ts)), nhóm Dự án có Dự án trên máy, Môi trường, Tài liệu từ code (PR #412) | Thêm mục "Máy chủ SSH" |
| Quyền lệnh Rust | `build.rs` khai báo lệnh, `capabilities/app.json` cấp cho cửa sổ `app` | Thêm lệnh `ssh_*` |
| Thư viện SSH | Worker chưa dùng `golang.org/x/crypto` | Thêm `golang.org/x/crypto/ssh`, `ssh/knownhosts` |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Khoá của máy | Cặp khoá ed25519 app dùng để đăng nhập. Mặc định là `~/.ssh/id_ed25519` (xem Q1). |
| Mục máy chủ | Một khối `Host` trong `~/.ssh/config`. Khối do app viết nằm giữa hai dòng đánh dấu `# >>> xdev-hive <alias>` và `# <<< xdev-hive`. |
| Khoá máy chủ (host key) | Khoá máy chủ SSH dùng để chứng minh nó là máy chủ thật. Dấu vân tay dạng `SHA256:…`. |
| Kiểm tra bằng khoá | Chạy `ssh -o BatchMode=yes … <alias> exit` của máy. Không có mật khẩu nào được dùng. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Thêm máy chủ và chuyển sang khoá (Priority: P1)

Người dùng mở màn Máy chủ SSH, bấm Thêm máy chủ, nhập `10.86.224.34`, cổng `22`, user `adminvm`, tên gợi nhớ
`hive-prod`. App hiện dấu vân tay khoá máy chủ. Người dùng đối chiếu rồi xác nhận, gõ mật khẩu một lần. App cài khoá,
kiểm tra đăng nhập bằng khoá, ghi alias vào `~/.ssh/config`.

**Acceptance Scenarios**:

1. **Given** máy chưa có khoá của máy, **When** người dùng bắt đầu cài khoá, **Then** app tạo cặp khoá ed25519 trước
   khi nối máy chủ và báo đường dẫn khoá vừa tạo.
2. **Given** máy đã có khoá của máy không có passphrase, **When** người dùng cài khoá, **Then** app dùng khoá đó và
   không tạo khoá mới.
3. **Given** máy chủ chưa có trong `known_hosts`, **When** người dùng bấm Tiếp, **Then** app hiện loại khoá và dấu
   vân tay `SHA256:…`, kèm lệnh để người quản trị máy chủ đọc dấu vân tay thật, và chỉ cho đi tiếp khi người dùng
   đánh dấu đã đối chiếu.
4. **Given** máy chủ đã có trong `known_hosts` và khoá khớp, **When** người dùng bấm Tiếp, **Then** app ghi "Máy chủ
   đã biết" và đi thẳng tới bước nhập mật khẩu.
5. **Given** khoá máy chủ khác khoá trong `known_hosts`, **Then** app dừng, cảnh báo có thể bị giả mạo, không có nút
   bỏ qua và không hỏi mật khẩu.
6. **Given** người dùng đã xác nhận dấu vân tay A, **When** lúc cài khoá máy chủ đưa khoá khác A, **Then** app dừng,
   không gửi mật khẩu.
7. **Given** mật khẩu đúng, **Then** khoá công khai có đúng một dòng trong `~/.ssh/authorized_keys` của user trên máy
   chủ, `~/.ssh` có quyền 700, `authorized_keys` có quyền 600.
8. **Given** khoá đã có trong `authorized_keys`, **When** cài lại, **Then** app không thêm dòng trùng.
9. **Given** mật khẩu sai, **Then** app báo "Sai mật khẩu hoặc máy chủ không cho đăng nhập bằng mật khẩu", xoá ô mật
   khẩu, không ghi `known_hosts` hay `config`.
10. **Given** cài khoá xong, **Then** app ghi khoá máy chủ vào `~/.ssh/known_hosts`, ghi khối alias vào
    `~/.ssh/config` (sau khi sao lưu), rồi chạy kiểm tra bằng khoá. Mục hiện "Khoá dùng được" chỉ khi kiểm tra đạt.
11. **Given** cài khoá xong nhưng kiểm tra bằng khoá không đạt, **Then** app hiện lý do (xem US3) và gợi ý cách sửa.
12. **Given** bất kỳ kết quả nào, **Then** ô mật khẩu trống sau khi app trả kết quả. Thử lại phải gõ lại mật khẩu.

### User Story 2 - Danh sách máy chủ và trạng thái (Priority: P1)

**Acceptance Scenarios**:

1. **Given** `~/.ssh/config` có khối `Host` viết tay (ví dụ `macmini`, `joinytran`, `srv86`) và khối do app viết,
   **When** người dùng mở màn, **Then** danh sách hiện mọi khối `Host` có tên cụ thể (không gồm mẫu có `*`, `?`, `!`),
   kèm `user@host:cổng`, nhãn "Do app quản lý" hoặc "Tự viết".
2. **Given** màn đang mở, **When** người dùng bấm Kiểm tra trên một mục hoặc Kiểm tra tất cả, **Then** mỗi mục hiện
   một trạng thái ở US3.
3. **Given** khối viết tay ở trạng thái "Cần thiết lập", **When** người dùng bấm Chuyển sang khoá, **Then** app chạy
   US1 với host, cổng, user lấy từ `ssh -G <alias>` và không sửa khối đó.
4. **Given** khối viết tay có `ProxyJump` hoặc `ProxyCommand`, **Then** nút Chuyển sang khoá bị khoá kèm lý do.
5. **Given** khoá của máy, **Then** đầu màn hiện đường dẫn, loại và dấu vân tay của khoá, nút chép khoá công khai.

### User Story 3 - Trạng thái kiểm tra bằng khoá (Priority: P1)

| Trạng thái | Khi nào |
|---|---|
| Khoá dùng được | `ssh -o BatchMode=yes` thoát mã 0 |
| Cần thiết lập | Máy chủ từ chối khoá (`Permission denied`) |
| Khoá máy chủ đã đổi | `ssh` báo host key khác `known_hosts` |
| Chưa biết máy chủ | Máy chủ chưa có trong `known_hosts` |
| Khoá cần passphrase | Khoá có passphrase và ssh-agent chưa nạp khoá |
| Quyền file khoá sai | `ssh` báo `UNPROTECTED PRIVATE KEY FILE` hoặc `Bad owner or permissions` |
| Không nối được | Hết giờ, từ chối kết nối, không phân giải được tên |
| Thiếu OpenSSH | Máy không có `ssh` (Windows: kèm hướng dẫn bật OpenSSH Client) |

**Acceptance Scenarios**:

1. **Given** mỗi tình huống trong bảng, **Then** app hiện đúng trạng thái và một câu gợi ý cách sửa bằng tiếng Việt.
2. **Given** kiểm tra một mục, **Then** app không dùng mật khẩu, không hỏi gì, và dừng sau tối đa 15 giây.

### User Story 4 - Xoá mục (Priority: P2)

**Acceptance Scenarios**:

1. **Given** mục do app quản lý, **When** người dùng xoá và xác nhận, **Then** app sao lưu `~/.ssh/config` rồi gỡ
   đúng khối giữa hai dòng đánh dấu, phần còn lại của file giữ nguyên từng byte.
2. **Given** xoá xong, **Then** app hiện hướng dẫn gỡ khoá khỏi máy chủ: dòng nào trong `authorized_keys` (nhận ra
   bằng comment của khoá). App không xoá file khoá, không sửa `known_hosts`.
3. **Given** mục viết tay, **Then** không có nút Xoá.

### User Story 5 - Hướng dẫn tắt đăng nhập bằng mật khẩu (Priority: P3)

**Acceptance Scenarios**:

1. **Given** mục ở trạng thái "Khoá dùng được", **When** người dùng bấm "Tắt đăng nhập bằng mật khẩu…", **Then** app
   hiện cảnh báo: mọi người khác vào máy chủ bằng mật khẩu sẽ bị chặn; giữ phiên đang mở và thử đăng nhập bằng khoá ở
   cửa sổ khác trước khi đóng; cần đường vào dự phòng (console).
2. **Given** người dùng đánh dấu "Tôi hiểu" và bấm Xem hướng dẫn, **Then** app hiện các lệnh để người dùng tự chạy
   trên máy chủ, có nút chép. App không chạy lệnh nào trên máy chủ.

### Edge Cases

- `~/.ssh` hoặc `~/.ssh/config` chưa có: app tạo với quyền đúng (FR-030).
- `~/.ssh/config` có `Include`, `Match`: app đọc khối `Host` trong chính file đó, không đọc file được `Include`. Khối
  mới đặt trước khối `Host *` đầu tiên nếu có, không thì ở cuối file.
- Alias trùng khối viết tay: app từ chối, đề nghị tên khác.
- Hai mục cùng host khác user: hai khối riêng.
- Khoá của máy có passphrase: app không hỏi passphrase, vẫn cài khoá công khai, báo trạng thái "Khoá cần passphrase"
  nếu ssh-agent chưa nạp khoá.
- `~/.ssh/id_ed25519` có mà thiếu `.pub`: app dựng lại khoá công khai từ khoá riêng (không passphrase) hoặc báo lỗi.
- Shell đăng nhập của user trên máy chủ không phải sh (fish, zsh, tcsh): máy chủ luôn chạy chuỗi lệnh qua shell đăng
  nhập, nên chuỗi lệnh chỉ là `exec sh -s`; script cài khoá đi qua stdin (FR-010).
- Máy chủ có SELinux: chạy `restorecon -R ~/.ssh` nếu có lệnh đó, như `ssh-copy-id`.
- Máy chủ chỉ cho `keyboard-interactive`: app chỉ trả lời một câu hỏi không hiện chữ có chữ "password"/"mật khẩu".
  Câu hỏi khác (mã OTP, 2FA) hoặc lượt thứ hai: app dừng, báo máy chủ cần xác thực thêm, không hỗ trợ (FR-008).
- Máy chủ khoá tài khoản sau vài lần sai (`pam_faillock`): mỗi lần bấm Cài khoá chỉ gửi mật khẩu một lần (FR-008).
- Khối viết tay mà `ssh -G <alias>` cho thấy khoá của máy sẽ không được dùng (`PubkeyAuthentication no`, hoặc
  `IdentitiesOnly yes` với `IdentityFile` khác): nút Chuyển sang khoá bị khoá kèm lý do, app đề nghị thêm alias mới do
  app quản lý cho cùng máy chủ.
- Windows: app ghi vào `%USERPROFILE%\.ssh`. OpenSSH của Windows và `ssh` của Git Bash (HOME là thư mục người dùng)
  cùng đọc thư mục này. WSL có `~/.ssh` riêng: không thuộc phạm vi; app hiện ghi chú chép khoá sang WSL nếu cần.
- `AuthorizedKeysFile` của máy chủ khác mặc định: cài xong nhưng kiểm tra không đạt, app báo "Cần thiết lập" kèm gợi ý.

## Requirements *(mandatory)*

### Functional Requirements

**Sidecar `hive-worker ssh`** (gói mới `worker/internal/sshkeys`)

- **FR-001**: Worker PHẢI có lệnh `hive-worker ssh <list|check|scan|setup|remove> --json`, in một đối tượng JSON ra
  stdout, lỗi ra stderr bằng tiếng Việt.
- **FR-002**: `list` PHẢI trả thông tin khoá của máy (đường dẫn, có hay không, loại, dấu vân tay, comment, có
  passphrase hay không) và các khối `Host` theo US2-1, kèm cờ `managed` và cờ `proxy`.
- **FR-003**: `check --alias` PHẢI chạy `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -- <alias> exit` và trả một trạng thái ở US3.
- **FR-004**: `scan --host --port` PHẢI trả loại khoá máy chủ, dấu vân tay SHA256 và một trong `known`, `unknown`,
  `changed` so với `~/.ssh/known_hosts`. `scan` KHÔNG ĐƯỢC xác thực với máy chủ.
- **FR-005**: `setup --host --port --user --alias --fingerprint` PHẢI đọc mật khẩu từ một dòng stdin và:
  1. tạo khoá của máy nếu chưa có (FR-020);
  2. nối máy chủ, so khoá máy chủ với `--fingerprint`; khác thì dừng trước khi xác thực;
  3. xác thực bằng `password`, rồi `keyboard-interactive`;
  4. cài khoá công khai (FR-010);
  5. thêm khoá máy chủ vào `known_hosts` nếu chưa có;
  6. ghi khối alias vào `config` nếu mục do app quản lý (FR-030);
  7. chạy `check` và trả kết quả từng bước.
- **FR-006**: `remove --alias` PHẢI gỡ khối do app quản lý theo FR-032 và từ chối khối viết tay.
- **FR-007**: Mật khẩu KHÔNG ĐƯỢC nằm trong tham số, biến môi trường, file, log hay nội dung lỗi. Worker PHẢI chỉ gửi
  mật khẩu tới máy chủ có khoá khớp `--fingerprint`, rồi thoát.
- **FR-008**: Mỗi lần `setup` PHẢI gửi mật khẩu tối đa một lần: phương thức `password` nếu máy chủ cho, không thì
  `keyboard-interactive` với đúng một câu hỏi theo Edge Cases. Sai thì dừng, không thử phương thức khác.

**Cài khoá trên máy chủ**

- **FR-010**: Chuỗi lệnh gửi máy chủ PHẢI là `exec sh -s`. Script cài khoá đi qua stdin của phiên SSH, dòng khoá nằm
  trong script giữa dấu nháy đơn sau khi worker kiểm nó chỉ gồm loại khoá, base64 và comment theo FR-011. Script PHẢI:
  `umask 077`; tạo `~/.ssh` và `authorized_keys` nếu thiếu; `chmod 700 ~/.ssh`, `chmod 600 authorized_keys`; thêm
  dòng xuống dòng nếu file không kết thúc bằng xuống dòng; chỉ thêm khi chưa có dòng nào chứa cùng phần base64 của
  khoá (dòng có option phía trước hay comment khác vẫn tính là đã có); chạy `restorecon` nếu có.
- **FR-011**: Comment của khoá mới PHẢI là `<user máy>@<tên máy> xdev-hive <ngày tạo>` để người quản trị nhận ra
  dòng nào cần gỡ. Ký tự ngoài `A-Z a-z 0-9 @ . _ -` và dấu cách được thay bằng `_`. Khoá có sẵn mà comment có ký tự
  khác: worker bỏ comment khi cài.

**Khoá của máy**

- **FR-020**: Khoá mới PHẢI là ed25519, định dạng OpenSSH, tạo bằng `crypto/ed25519` và `ssh.MarshalPrivateKey`.
  Vị trí và passphrase: theo Q1, Q2.
- **FR-021**: Worker PHẢI ghi khoá riêng với quyền chỉ người dùng hiện tại đọc được: 0600 trên macOS/Linux; trên
  Windows là DACL được bảo vệ (không kế thừa) cho người dùng hiện tại, SYSTEM và Administrators. `~/.ssh` tạo mới có
  quyền 0700 trên macOS/Linux.
- **FR-022**: Worker chỉ dùng khoá ở vị trí theo Q1: có rồi thì dùng, chưa có thì tạo. Worker KHÔNG ĐƯỢC ghi đè khoá
  đã có và không đụng tới khoá khác trong `~/.ssh` (`id_rsa`, …).
- **FR-023**: Khoá riêng KHÔNG ĐƯỢC đi ra khỏi worker: không về giao diện, không vào JSON, không vào log.

**`~/.ssh/config` và `known_hosts`**

- **FR-030**: Khối do app viết PHẢI có dạng:

  ```
  # >>> xdev-hive hive-prod
  Host hive-prod
      HostName 10.86.224.34
      User adminvm
      Port 22
      IdentityFile ~/.ssh/id_ed25519
      IdentitiesOnly yes
  # <<< xdev-hive
  ```

  Alias chỉ gồm `A-Z a-z 0-9 . _ -`, không bắt đầu bằng `-`, tối đa 64 ký tự.
- **FR-031**: Trước mỗi lần ghi `config`, worker PHẢI sao lưu file thành `config.xdev-hive-<YYYYMMDD-HHMMSS>.bak`
  (giữ 5 bản mới nhất) rồi ghi file tạm và đổi tên đè. Worker PHẢI giữ nguyên kiểu xuống dòng (LF/CRLF) và quyền
  của file cũ: trên macOS/Linux đặt mode của file cũ cho file tạm; trên Windows chép DACL và owner của file cũ sang
  file tạm trước khi đổi tên (đổi tên giữ ACL của file tạm, nên không chép thì mất ACL riêng của file cũ). File mới tạo
  có quyền 0600 trên macOS/Linux.
- **FR-032**: Gỡ khối PHẢI chỉ xoá các dòng từ `# >>> xdev-hive <alias>` tới `# <<< xdev-hive` tương ứng. Thiếu dòng
  đóng thì worker từ chối và không ghi gì.
- **FR-033**: Worker PHẢI chỉ thêm dòng vào cuối `known_hosts` (dạng `[host]:port` khi cổng khác 22), không sửa hay
  xoá dòng có sẵn.
- **FR-034**: So khớp `known_hosts` PHẢI dùng `golang.org/x/crypto/ssh/knownhosts` (đọc được dòng băm `|1|…`). Khi máy
  chủ đã có khoá trong `known_hosts`, worker PHẢI xin đúng loại khoá đó để không báo nhầm "đã đổi".
- **FR-035**: Với máy chủ chưa biết, `scan` và `setup` PHẢI xin khoá máy chủ theo thứ tự `ssh-ed25519`, ECDSA, RSA
  (`x/crypto/ssh` mặc định xin ECDSA và RSA trước ed25519), và trả loại khoá thật nhận được. Lệnh cho người quản trị
  đối chiếu (US1-3) PHẢI theo đúng loại đó (`ssh_host_ed25519_key.pub`, `ssh_host_ecdsa_key.pub`,
  `ssh_host_rsa_key.pub`).
- **FR-036**: `check` PHẢI báo "Khoá cần passphrase" dựa vào cờ `encrypted` của khoá và việc ssh-agent chưa có khoá
  (`ssh-add -L`), không dựa vào stderr: với `BatchMode=yes`, khoá có passphrase và khoá bị máy chủ từ chối đều ra
  `Permission denied (publickey)`.
- **FR-037**: Trên Windows, `check` PHẢI dùng `%SystemRoot%\System32\OpenSSH\ssh.exe` nếu có, không thì `ssh` trong PATH.
  Trên macOS/Linux dùng `ssh` trong PATH đăng nhập.

**App (Rust)**

- **FR-040**: Rust PHẢI có lệnh `ssh_list`, `ssh_check`, `ssh_scan`, `ssh_setup`, `ssh_remove`, khai báo trong
  `build.rs` và chỉ cấp cho cửa sổ `app` trong `capabilities/app.json`.
- **FR-041**: Rust PHẢI kiểm tham số trước khi gọi sidecar: host (tên DNS, IPv4, IPv6, không ký tự điều khiển, không
  bắt đầu bằng `-`), cổng 1–65535, user (`A-Z a-z 0-9 . _ -`, không bắt đầu bằng `-`, tối đa 64), alias (FR-030),
  dấu vân tay (`SHA256:` + base64 không đệm, 43 ký tự).
- **FR-042**: `ssh_setup` PHẢI ghi mật khẩu vào stdin của sidecar, rồi ghi đè vùng nhớ chứa mật khẩu bằng 0 (cố gắng
  tốt nhất). Rust KHÔNG ĐƯỢC log tham số của lệnh này.
- **FR-043**: Mỗi lúc chỉ một `ssh_setup` chạy; lệnh dừng sau 60 giây.

**Giao diện**

- **FR-050**: Menu PHẢI có mục "Máy chủ SSH" (en: "SSH servers") trong nhóm Dự án, sau Môi trường. Mục hiện với mọi
  hồ sơ và chạy được khi chưa đăng nhập Hive.
- **FR-051**: Hộp thoại thêm máy chủ có ba bước: thông tin máy chủ → khoá máy chủ → mật khẩu. Ô mật khẩu là
  `type="password"`, `autocomplete="off"`, không lưu vào state dài hạn, được xoá ngay khi gửi.
- **FR-052**: Mọi chữ trên giao diện có bản tiếng Việt và tiếng Anh theo `src/lib/i18n.ts`; thông báo lỗi tiếng Việt.

### Key Entities

- **SshKeyInfo**: `path`, `exists`, `type`, `fingerprint`, `comment`, `encrypted`, `publicKey` (một dòng `.pub`).
- **SshHost**: `alias`, `hostName`, `port`, `user`, `identityFile`, `managed`, `proxy`.
- **SshCheck**: `status` (một giá trị ở US3), `detail` (đoạn cuối stderr của `ssh`, đã cắt ngắn).
- **SshScan**: `algorithm`, `fingerprint`, `known` (`known` | `unknown` | `changed`).

## Thiết kế kỹ thuật

### Cách làm SSH: so sánh

| Cách | Ưu | Nhược |
|---|---|---|
| A. Crate Rust `russh` | Thuần Rust, không cần OpenSSH | Thêm nhiều crate mã hoá vào app; cộng đồng duy trì, đã có vài CVE [Suy luận: theo RustSec, chưa kiểm lại hôm nay]; mật khẩu nằm trong tiến trình app chạy cả ngày |
| B. Crate Rust `ssh2` (libssh2) | Thư viện C lâu đời | Cần build C và OpenSSL trên Windows; khó build chéo |
| C. Gọi `ssh` của máy + `SSH_ASKPASS` | Không thêm thư viện | Phải viết chương trình askpass và kênh truyền mật khẩu riêng; `SSH_ASKPASS_REQUIRE` cần OpenSSH ≥ 8.4; dễ lộ mật khẩu qua biến môi trường hoặc file |
| **D. Sidecar Go `golang.org/x/crypto/ssh` + `ssh` của máy để kiểm tra** (chọn) | Thư viện do nhóm Go duy trì; repo đã gọi sidecar cho việc tại máy (`gitgroups`, `projects`); mật khẩu chỉ sống trong tiến trình ngắn rồi thoát; kiểm tra bằng đúng `ssh` người dùng sẽ dùng | Worker lớn thêm [Suy luận: khoảng 1–2 MB]; máy dev Windows này không có Go nên chỉ test được qua Docker hoặc CI |

Lý do chọn D: bước dùng mật khẩu cần một thư viện SSH trong tiến trình; Go `x/crypto/ssh` là thư viện được dùng rộng
nhất trong ba ngôn ngữ của repo. Bước kiểm tra dùng `ssh` của máy vì đó là đường người dùng và `remote.sh` dùng thật:
nó đọc `~/.ssh/config`, kiểm quyền file khoá, dùng ssh-agent.

### Xác minh khoá máy chủ (TOFU có xác nhận)

1. `scan` lấy khoá máy chủ mà không xác thực, trả dấu vân tay.
2. Máy chủ chưa biết: người dùng đối chiếu dấu vân tay với người quản trị máy chủ. App hiện lệnh cho người quản trị
   theo loại khoá nhận được (FR-035), ví dụ `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
3. `setup` nhận dấu vân tay đã xác nhận và so lại lúc bắt tay. Khác thì dừng trước khi gửi mật khẩu. Cách này chặn
   trường hợp máy chủ đổi giữa hai bước.
4. Khoá máy chủ khác `known_hosts`: dừng hẳn, không có nút bỏ qua. Người dùng tự xử lý sau khi hỏi người quản trị.

### Mật khẩu trong bộ nhớ

- Đường đi: ô nhập trong webview → IPC Tauri → Rust → stdin của sidecar → bước xác thực SSH (đã mã hoá, tới máy chủ
  đã xác minh). Không có bước nào ghi ra đĩa.
- Rust ghi đè buffer bằng 0 sau khi ghi vào stdin. JavaScript và Go không xoá được chuỗi một cách chắc chắn. Vì vậy
  bước xác thực chạy trong sidecar sống ngắn: tiến trình thoát thì bộ nhớ được trả lại cho hệ điều hành.
- Mô hình đe doạ: chặn người khác trên mạng, người dùng khác trên máy, và lộ qua log/file. Không chặn được phần mềm
  độc hại chạy dưới chính tài khoản người dùng (phần mềm đó đọc được bộ nhớ và bàn phím).

### Quyền file

| File | macOS/Linux | Windows |
|---|---|---|
| `~/.ssh` | 0700 khi tạo mới | Giữ ACL kế thừa từ thư mục người dùng |
| Khoá riêng | 0600 | DACL bảo vệ: người dùng hiện tại, SYSTEM, Administrators |
| `.pub`, `known_hosts` | 0644 khi tạo mới, giữ quyền cũ khi sửa | Kế thừa |
| `config` | 0600 khi tạo mới, giữ quyền cũ khi sửa | Kế thừa |

OpenSSH trên Windows từ chối khoá riêng mà người khác đọc được [Suy luận: theo tài liệu Win32-OpenSSH về kiểm quyền
file, chưa thử trên máy này]. Trạng thái "Quyền file khoá sai" (US3) báo trường hợp này. App không sửa ACL của khoá
người dùng tự tạo.

### Hướng dẫn tắt mật khẩu (US5)

App hiện, không chạy:

```sh
# Trên máy chủ, giữ phiên này mở cho tới khi thử xong ở cửa sổ khác.
echo 'PasswordAuthentication no
KbdInteractiveAuthentication no' | sudo tee /etc/ssh/sshd_config.d/00-xdev-hive-no-password.conf
sudo sshd -t && sudo systemctl reload ssh    # RHEL/Rocky: sshd
sudo sshd -T | grep -Ei 'passwordauthentication|kbdinteractiveauthentication'
```

Tên file bắt đầu bằng `00-` vì `sshd` lấy giá trị đầu tiên gặp, và Ubuntu có thể có `50-cloud-init.conf` bật mật
khẩu [Suy luận: theo man sshd_config "first obtained value"; cần thử trên máy chủ thật].

## Kiểm thử

Viết test trước khi viết code.

- **Go** (`worker/internal/sshkeys`):
  - Đọc và ghi `config`: giữ nguyên byte phần ngoài khối, CRLF, `Include`, `Match`, `Host *`; gỡ khối; thiếu dòng
    đóng; alias trùng.
  - `known_hosts`: dòng thường, dòng băm, `[host]:port`, khoá đổi, nhiều loại khoá.
  - Tạo khoá: định dạng OpenSSH đọc lại được, quyền 0600 (Unix), DACL (Windows, chạy trên CI `worker-windows`).
  - Cài khoá: máy chủ SSH giả trong tiến trình (`x/crypto/ssh` phía server) nhận `password` và
    `keyboard-interactive`, chạy script cài khoá trong HOME tạm bằng `sh` (bỏ qua trên Windows). Kiểm: khoá đúng một
    dòng kể cả khi đã có dòng cùng khoá khác comment hoặc có option; quyền 700/600; khoá máy chủ khác dấu vân tay thì
    máy chủ giả không nhận mật khẩu nào; mật khẩu chỉ được gửi một lần; câu hỏi OTP thì dừng; máy chủ có cả ECDSA và
    ed25519 thì `scan` trả ed25519.
  - Mật khẩu không có trong stdout, stderr, file nào trong HOME tạm.
  - Phân loại lỗi `ssh` theo US3 từ mẫu stderr.
- **E2E có Docker** (bật bằng biến môi trường, bỏ qua khi không có Docker): container OpenSSH server với user và mật
  khẩu sinh ngẫu nhiên trong test; chạy `setup` thật rồi `ssh -o BatchMode=yes` thật.
- **Rust**: kiểm tham số (FR-041), lệnh có trong `build.rs` và `capabilities/app.json` (test `capabilities_audit`).
- **Giao diện** (Vitest, giả `window.__TAURI__`): ba bước của hộp thoại, chặn khi khoá máy chủ đổi, ô mật khẩu trống
  sau khi trả kết quả, các trạng thái US3, xoá mục, cảnh báo US5.

Máy dev Windows này không có Go, Rust và trình liên kết MSVC. Kế hoạch: chạy `go test` và e2e trong container Docker
(`golang`, OpenSSH server); `cargo check`/`cargo test` trong container Linux có thư viện Tauri, hoặc chỉ trên CI.

## Câu hỏi cho chủ dự án

- **Q1 - Khoá ở đâu?** Đề xuất: dùng `~/.ssh/id_ed25519`; chưa có thì tạo ở đó. Lý do: `ssh` tự thử khoá này với mọi
  máy chủ, nên `deploy/remote.sh adminvm@10.86.224.34` chạy được cả khi không dùng alias. Cách khác: khoá riêng của
  app `~/.ssh/xdev-hive_ed25519`. Cách này dễ thu hồi riêng, nhưng chỉ dùng được qua alias hoặc `-i`.
- **Q2 - Khoá mới có passphrase không?** Đề xuất: không passphrase. Khoá chỉ người dùng đọc được. Có passphrase thì
  an toàn hơn khi mất máy, nhưng cần ssh-agent; trên Windows dịch vụ ssh-agent mặc định tắt và cần quyền quản trị để
  bật.

## Để người làm quyết định

- Tên lệnh con, tên trường JSON, bố cục màn (trong giới hạn FR-050–052).
- Màn có tự kiểm tra mọi mục khi mở hay chỉ khi bấm.
- Thứ tự thử `password` và `keyboard-interactive`.
- Số lượt kiểm tra chạy song song.
