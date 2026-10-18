# Implementation Plan: Chuyển đăng nhập SSH từ mật khẩu sang khoá trong app desktop

**Branch**: `ai/desktop-ssh-keys` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

> Người làm: theo từng task, viết test trước. Bước đánh dấu `- [ ]`.

**Mục tiêu:** màn "Máy chủ SSH" trong app desktop cài khoá công khai lên máy chủ bằng mật khẩu gõ một lần, rồi chỉ
dùng khoá.

**Kiến trúc:** logic SSH ở gói Go mới `worker/internal/sshkeys`, gọi qua lệnh `hive-worker ssh … --json` (cùng cách
với `gitgroups`, `projects`). Rust (`src-tauri/src/ssh_keys.rs`) chỉ kiểm tham số, chuyển mật khẩu qua stdin và trả
JSON. Giao diện React gọi lệnh Tauri `ssh_*`.

**Công nghệ:** Go 1.27.2 + `golang.org/x/crypto v0.57.0` (`ssh`, `ssh/knownhosts`; v0.58.0 phát hành 09/10, chưa đủ
hai tuần), `golang.org/x/sys/windows` (DACL). Tauri 2 + `tauri-plugin-shell`. React 19, `@xdev-hive/ui`, Vitest.

## Ràng buộc chung

- Mật khẩu: chỉ qua stdin của sidecar; không tham số, biến môi trường, file, log, nội dung lỗi (FR-007, FR-042).
- Gửi mật khẩu tối đa một lần mỗi lần `setup`, chỉ tới máy chủ có dấu vân tay khớp `--fingerprint` (FR-007, FR-008).
- Khoá của máy: `~/.ssh/id_ed25519`, khoá mới không passphrase (Q1, Q2 đã chốt). Không ghi đè khoá có sẵn (FR-022).
- Khối config: `# >>> xdev-hive <alias>` … `# <<< xdev-hive` (FR-030). Alias `^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`.
- Comment khoá mới: `<user>@<máy> xdev-hive <YYYY-MM-DD>`, ký tự ngoài `A-Za-z0-9@._-` và dấu cách thành `_`.
- Tiến trình con trong worker dùng `procattr.CommandContext` (không gọi `exec.Command` trực tiếp).
- Chữ giao diện có bản `vi` và `en` (`Dict`), lỗi tiếng Việt. Import web/desktop bằng alias `@/…`.
- Comment giải thích vì sao. Commit message tiếng Anh.

## Trọng tâm review

1. Máy chủ có cả ECDSA và ed25519, `known_hosts` chỉ có một loại: không được báo nhầm "đã đổi" (FR-034). Test ở Task 3.
2. `~/.ssh/config` có CRLF, `Include`, `Match`, `Host *`: phần ngoài khối giữ nguyên từng byte. Test ở Task 1.
3. Mật khẩu sai: không ghi `known_hosts`/`config`, mật khẩu không nằm trong stderr. Test ở Task 4 và Task 6.
4. `authorized_keys` có sẵn khoá với option hay comment khác, hoặc không có dòng xuống cuối file: không thêm trùng, không
   dính dòng. Test ở Task 4.
5. Máy chủ hỏi OTP sau mật khẩu (keyboard-interactive lượt hai): dừng, báo không hỗ trợ. Test ở Task 4.

---

### Task 1: Đọc và sửa `~/.ssh/config`

**Files:** tạo `worker/internal/sshkeys/config.go`, `config_test.go`, `perm_unix.go`, `perm_windows.go`.

**Produces:**
- `type Host struct { Alias, HostName, User string; Port int; IdentityFile string; Managed bool; Proxy bool; KeyUsable bool }`
  (JSON camelCase; `KeyUsable` do Task 5 điền).
- `func ParseConfig(data []byte) []Host`: mỗi khối `Host` có ít nhất một tên không chứa `* ? !`; alias là tên cụ thể
  đầu tiên; `Managed` khi khối nằm giữa hai dòng đánh dấu.
- `func AddBlock(data []byte, h Host, identityFile string) ([]byte, error)`: `ErrAliasExists` nếu alias đã có trong
  bất kỳ khối nào. Chèn trước khối `Host *` hay `Match all` đầu tiên, không thì cuối file. Xuống dòng theo file (có
  `\r\n` thì CRLF).
- `func RemoveBlock(data []byte, alias string) ([]byte, error)`: `ErrNotManaged`, `ErrUnclosedBlock`.
- `func WriteFileSafe(path string, data []byte, backup bool, now time.Time) error`: sao lưu
  `config.xdev-hive-YYYYMMDD-HHMMSS.bak` (giữ 5), file tạm cùng thư mục, `copySecurity(old, tmp)`, đổi tên đè; file
  mới 0600 (Unix).
- `func copySecurity(from, to string) error` (Unix: chmod theo mode cũ; Windows: chép owner + DACL bằng
  `GetNamedSecurityInfo`/`SetNamedSecurityInfo`), `func restrictPrivate(path string) error` (Unix 0600; Windows DACL
  `D:P(A;;FA;;;<SID>)(A;;FA;;;SY)(A;;FA;;;BA)` theo cách `pipeSDDL`).

- [ ] Test `TestParseConfig` (khối viết tay, khối quản lý, `Host *`, `Host a b`, `Match`, comment), `TestAddBlock`
  (chèn trước `Host *`; cuối file; CRLF giữ CRLF; alias trùng → `ErrAliasExists`; byte ngoài khối không đổi),
  `TestRemoveBlock` (gỡ đúng khối, phần còn lại bằng byte với bản trước khi thêm; thiếu dòng đóng; khối viết tay),
  `TestWriteFileSafe` (bản sao lưu có nội dung cũ, giữ 5 bản, mode 0600 giữ nguyên trên Unix).
- [ ] Chạy `go test ./internal/sshkeys/` trong container: FAIL (chưa có code).
- [ ] Viết code. Chạy lại: PASS. `gofmt -l .`, `go vet ./...` sạch.
- [ ] Commit `feat(worker): parse and edit managed ssh config blocks`.

### Task 2: Khoá của máy

**Files:** tạo `worker/internal/sshkeys/keys.go`, `keys_test.go`; sửa `worker/go.mod`, `go.sum`
(`golang.org/x/crypto v0.57.0`).

**Produces:**
- `type KeyInfo struct { Path string; Exists bool; Type, Fingerprint, Comment, PublicKey string; Encrypted bool }`.
- `func DefaultKeyPath(home string) string` → `<home>/.ssh/id_ed25519`.
- `func InspectKey(path string) (KeyInfo, error)`: đọc `.pub`; thiếu `.pub` thì dựng từ khoá riêng không passphrase;
  `Encrypted` từ `*ssh.PassphraseMissingError`. Không trả khoá riêng.
- `func GenerateKey(path, comment string) (KeyInfo, error)`: `ErrKeyExists` nếu đã có; tạo `~/.ssh` 0700; ed25519 +
  `ssh.MarshalPrivateKey`; mở bằng `O_EXCL`, `restrictPrivate`; `.pub` 0644.
- `func KeyComment(user, host string, now time.Time) string`.
- `func AuthorizedLine(k KeyInfo) (string, error)`: `<type> <base64> [comment]`; bỏ comment có ký tự ngoài FR-011.

- [ ] Test: tạo khoá → `InspectKey` đọc lại đúng loại `ssh-ed25519`, dấu vân tay `SHA256:`; tạo lần hai →
  `ErrKeyExists`, file cũ không đổi; mode 0600/0644 (Unix); khoá có passphrase → `Encrypted`; thiếu `.pub`;
  `KeyComment("ha", "MAY 1", …) == "ha@MAY_1 xdev-hive 2026-10-17"`; `AuthorizedLine` bỏ comment có `'`.
- [ ] FAIL → code → PASS → commit `feat(worker): inspect and generate the machine ssh key`.

### Task 3: `known_hosts` và quét khoá máy chủ

**Files:** tạo `worker/internal/sshkeys/knownhosts.go`, `scan.go`, `testserver_test.go` (máy chủ SSH giả trong tiến
trình, dùng chung cho Task 3–4), `knownhosts_test.go`, `scan_test.go`.

**Produces:**
- `func HostKeyStatus(knownHosts, host string, port int, key ssh.PublicKey) (string, error)` → `known|unknown|changed`.
- `func KnownKeyTypes(knownHosts, host string, port int) []string`: loại khoá đã biết (lấy `Want` của
  `*knownhosts.KeyError` khi gọi callback với khoá giả).
- `func hostKeyAlgorithms(known []string) []string`: đã biết → đúng các loại đó (`ssh-rsa` → `rsa-sha2-512`,
  `rsa-sha2-256`, `ssh-rsa`); chưa biết → ed25519, ecdsa 256/384/521, rsa-sha2-512, rsa-sha2-256 (FR-035).
- `func AppendKnownHost(knownHosts, host string, port int, key ssh.PublicKey) error`: dùng `knownhosts.Line` +
  `knownhosts.Normalize`; bỏ qua nếu đã có; thêm `\n` trước nếu file không kết thúc bằng xuống dòng.
- `type ScanResult struct { Algorithm, Fingerprint, Known, AdminCommand string }`;
  `func Scan(ctx context.Context, host string, port int, knownHosts string) (ScanResult, error)`: callback chụp khoá
  rồi trả lỗi canh để dừng trước xác thực. `AdminCommand` = `ssh-keygen -lf /etc/ssh/ssh_host_<ed25519|ecdsa|rsa>_key.pub`.

- [ ] Test: dòng thường, dòng băm `|1|…`, `[host]:2222`; khoá khác → `changed`; máy chủ giả có ECDSA + ed25519, chưa
  biết → `Scan` trả `ssh-ed25519`; `known_hosts` chỉ có ECDSA của máy chủ đó → `Scan` trả `known` (không `changed`);
  `AppendKnownHost` hai lần → một dòng; máy chủ giả không nhận yêu cầu xác thực nào trong `Scan`.
- [ ] FAIL → code → PASS → commit `feat(worker): scan ssh host keys against known_hosts`.

### Task 4: Cài khoá bằng mật khẩu

**Files:** tạo `worker/internal/sshkeys/install.go`, `install_test.go`.

**Produces:**
- `func InstallScript(keyLine string) (string, error)`: kiểm `keyLine` khớp
  `^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]+)?$`. Script POSIX sh: `umask 077`, `mkdir -p`, `chmod`,
  thêm `\n` nếu thiếu (`tail -c1`), so phần base64 bằng `awk` (field bằng khoá), `restorecon -R ~/.ssh` nếu có.
- `type InstallOptions struct { Host string; Port int; User string; Fingerprint string; Password []byte;
  KnownHosts string; Timeout time.Duration }`.
- `func Install(ctx context.Context, o InstallOptions, keyLine string) (ssh.PublicKey, error)`: chuỗi lệnh
  `exec sh -s`, script qua stdin. Lỗi: `ErrHostKeyMismatch`, `ErrAuthFailed`, `ErrExtraAuth`, `*InstallError{Stderr}`.
- Xác thực một lần: `ssh.PasswordCallback` và `ssh.KeyboardInteractive` dùng chung cờ `sent`; đã gửi thì trả lỗi.
  Keyboard-interactive chỉ trả lời đúng một câu hỏi, `echo=false`, chứa `password`/`mật khẩu` (không phân biệt hoa
  thường); lượt rỗng (không câu hỏi) trả lời rỗng.

- [ ] Test với máy chủ giả (bỏ qua trên Windows vì cần `sh`): cài vào HOME tạm → `authorized_keys` có đúng một dòng,
  quyền 700/600; chạy lại → vẫn một dòng; có sẵn `from="x" ssh-ed25519 <cùng base64> khác-comment` → không thêm;
  file không có `\n` cuối → dòng mới không dính; dấu vân tay sai → `ErrHostKeyMismatch` và máy chủ không nhận mật
  khẩu; mật khẩu sai → `ErrAuthFailed`, máy chủ nhận mật khẩu đúng một lần; máy chủ chỉ có keyboard-interactive →
  thành công; lượt hai hỏi "Verification code:" → `ErrExtraAuth`; chuỗi lệnh máy chủ nhận == `exec sh -s`.
- [ ] Test `InstallScript` từ chối dòng có `'`, xuống dòng, `$(`.
- [ ] FAIL → code → PASS → commit `feat(worker): install the public key over a one-shot password login`.

### Task 5: Kiểm tra bằng `ssh` của máy

**Files:** tạo `worker/internal/sshkeys/check.go`, `check_test.go`.

**Produces:**
- Trạng thái: `ok`, `auth`, `hostkey_changed`, `hostkey_unknown`, `passphrase`, `key_perms`, `unreachable`,
  `no_ssh`, `error`.
- `func Classify(exit int, stderr string) string`: thứ tự `key_perms` (`UNPROTECTED PRIVATE KEY FILE`, `Bad owner or
  permissions`) → `hostkey_changed` (`REMOTE HOST IDENTIFICATION HAS CHANGED`) → `hostkey_unknown` (`Host key
  verification failed`, `No … host key is known`) → `auth` (`Permission denied`) → `unreachable` (`timed out`,
  `Connection refused`, `Could not resolve hostname`, `No route to host`, `Network is unreachable`) → `error`.
- `type CheckResult struct { Status, Detail string }` (`Detail`: 300 ký tự cuối stderr).
- `func SSHPath() (string, error)`: Windows ưu tiên `%SystemRoot%\System32\OpenSSH\ssh.exe` (FR-037).
- `func Check(ctx context.Context, sshPath, alias string, key KeyInfo) CheckResult`: lệnh FR-003, thời hạn 15 giây;
  `auth` + `key.Encrypted` + `ssh-add -L` không có khoá → `passphrase` (FR-036).
- `type Resolved struct { HostName, User string; Port int; IdentityFiles []string; IdentitiesOnly, Pubkey, Proxy bool }`;
  `func ParseResolved(out string) Resolved` (đọc `ssh -G`), `func Resolve(ctx, sshPath, alias string) (Resolved, error)`;
  `func (r Resolved) Uses(keyPath, home string) bool`: false nếu `Pubkey` tắt, hoặc `IdentitiesOnly` mà không có
  `keyPath` (so sau khi mở `~`).

- [ ] Test bảng `Classify` (mỗi trạng thái một mẫu stderr thật của OpenSSH, kể cả perms + Permission denied cùng lúc
  → `key_perms`); `ParseResolved` với `proxyjump none` (không phải proxy) và `proxyjump bastion`; `Uses`.
- [ ] FAIL → code → PASS → commit `feat(worker): check key-only ssh login with the system client`.

### Task 6: Lệnh `hive-worker ssh` và e2e

**Files:** tạo `worker/cmd/hive-worker/ssh.go`, `ssh_test.go`, `worker/internal/sshkeys/e2e_test.go`; sửa
`worker/cmd/hive-worker/main.go` (case `"ssh"`, usage).

**Produces** (JSON camelCase, in ra stdout; lỗi tiếng Việt ra stderr, mã 1; sai cách dùng mã 2):
- `list` → `{ "ssh": string, "key": KeyInfo, "hosts": []Host, "configPath": string }`; mỗi khối viết tay được
  `Resolve` để điền `hostName`, `port`, `user`, `proxy`, `keyUsable` khi có `ssh`.
- `check --alias A` → `CheckResult`.
- `scan --host H --port P` → `ScanResult`.
- `setup --host H --port P --user U --alias A --fingerprint F` (mật khẩu: dòng đầu stdin) →
  `{ "key": KeyInfo, "keyCreated": bool, "configWritten": bool, "check": CheckResult }`. Alias là khối viết tay thì
  không ghi config và PHẢI khớp `Resolve` (host, port, user), sai thì từ chối. Thứ tự theo FR-005; lỗi trước bước
  cài khoá thì không ghi `known_hosts`/`config`.
- `remove --alias A` → như `list`.
- `var sshHome = os.UserHomeDir` để test thay.

- [ ] Test (`ssh_test.go`): `list` với HOME tạm; `setup` mật khẩu sai qua máy chủ giả → mã 1, stderr không chứa mật
  khẩu, `config` và `known_hosts` không đổi; `remove` khối viết tay → mã 1; thiếu cờ → mã 2.
- [ ] `e2e_test.go`: chỉ chạy khi có `HIVE_SSH_E2E_ADDR`, `HIVE_SSH_E2E_USER`, `HIVE_SSH_E2E_PASSWORD`; chạy `Scan`,
  `setup` thật, rồi `Check` bằng `ssh` thật phải `ok`.
- [ ] Chạy e2e: container sshd (alpine + openssh, user và mật khẩu sinh ngẫu nhiên) và container golang trên cùng
  mạng Docker. PASS.
- [ ] Commit `feat(worker): add hive-worker ssh command for the desktop app`.

### Task 7: Lệnh Rust

**Files:** tạo `apps/desktop/src-tauri/src/ssh_keys.rs`; sửa `lib.rs` (mod, `.manage(ssh_keys::SetupLock::default())`,
`generate_handler!`), `build.rs`, `capabilities/app.json` (quyền + mô tả).

**Produces:** lệnh `ssh_list()`, `ssh_check(alias)`, `ssh_scan(host, port)`, `ssh_setup(host, port, user, alias,
fingerprint, password)`, `ssh_remove(alias)`, đều trả `serde_json::Value`.
- `pub fn host_arg`, `port_arg`, `user_arg`, `alias_arg`, `fingerprint_arg` (FR-041), `pub fn setup_args(...)`.
- `ssh_setup`: `SetupLock(AtomicBool)` (đang chạy → lỗi "Đang cài khoá cho máy chủ khác."); spawn sidecar, ghi
  `password + "\n"` vào stdin rồi `wipe(password)` (`into_bytes`, `fill(0)`, `black_box`); gom stdout/stderr; quá
  60 giây thì kill.

- [ ] Test `mod tests`: host hợp lệ (`10.86.224.34`, `srv.example.vn`, `::1`), không hợp lệ (`-oProxyCommand=x`,
  `a b`, chuỗi rỗng, ký tự điều khiển); cổng 0/65536; user `-x`; alias `a*`, `-a`, 65 ký tự; dấu vân tay thiếu
  `SHA256:` hay sai độ dài; `setup_args` không chứa mật khẩu. `capabilities_audit` tự kiểm lệnh mới.
- [ ] Chạy `cargo test --locked` trong container Linux có thư viện Tauri (hoặc để CI nếu không dựng được). Commit
  `feat(desktop): add ssh_* commands backed by the worker sidecar`.

### Task 8: Màn Máy chủ SSH

**Files:** tạo `apps/desktop/src/lib/ssh.ts`, `src/screens/ssh-screen.tsx`, `src/components/ssh-add-dialog.tsx`,
`src/components/ssh-password-off-dialog.tsx`, `src/screens/ssh-screen.test.tsx`; sửa `src/lib/nav.ts`,
`src/lib/nav.test.ts`, `src/screens/index.ts`.

**Produces:** kiểu TS khớp JSON ở Task 6; `sshList()`, `sshCheck(alias)`, `sshScan(host, port)`,
`sshSetup({host, port, user, alias, fingerprint, password})`, `sshRemove(alias)`; `ScreenId` thêm `"ssh"`; mục
`{ id: "ssh", label: { vi: "Máy chủ SSH", en: "SSH servers" }, icon: ServerIcon }` trong nhóm `project` sau `setup`,
không `needs`.

- [ ] Test (giả `window.__TAURI__` như `git-groups.test.tsx`):
  - danh sách hiện khối quản lý và viết tay, khoá của máy, trạng thái từ `ssh_check` (tự kiểm khi mở);
  - thêm máy chủ: bước 1 → `ssh_scan`; `unknown` thì nút Tiếp bị khoá tới khi đánh dấu đã đối chiếu, hiện
    `adminCommand`; `changed` thì hiện cảnh báo, không có ô mật khẩu; `known` thì sang thẳng bước mật khẩu;
  - `ssh_setup` nhận đúng tham số; sau khi trả (thành công hay lỗi) ô mật khẩu trống;
  - khối viết tay `keyUsable=false` hoặc `proxy=true`: nút Chuyển sang khoá bị khoá kèm lý do;
  - Xoá chỉ có ở khối quản lý, có xác nhận, gọi `ssh_remove`, hiện hướng dẫn gỡ khoá trên máy chủ;
  - "Tắt đăng nhập bằng mật khẩu…" chỉ khi `ok`; lệnh chỉ hiện sau khi đánh dấu "Tôi hiểu";
  - thiếu `ssh` → Alert hướng dẫn bật OpenSSH Client;
  - `nav.test.ts`: mục `ssh` có cho mọi hồ sơ.
- [ ] FAIL → code → PASS: `corepack pnpm --filter @xdev-hive/desktop test`, `typecheck`, biome trên file đổi.
- [ ] Commit `feat(desktop): add SSH servers screen`.

### Task 9: Tài liệu và kiểm cuối

**Files:** sửa `apps/desktop/README.md` (mục "Màn Máy chủ SSH"), `worker/README` nếu có danh sách lệnh, ghi chú
chung của phiên.

- [ ] Ghi tài liệu. Chạy lại toàn bộ: `go test ./...`, `go vet`, `gofmt -l` (container); desktop test, typecheck,
  biome; `pnpm deps`; cargo (container hoặc ghi rõ chỉ CI).
- [ ] Commit `docs(desktop): document the SSH servers screen`.
