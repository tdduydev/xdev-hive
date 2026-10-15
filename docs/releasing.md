# Phát hành worker và app desktop

Bản phát hành của `hive-worker` dựng bằng goreleaser (`worker/.goreleaser.yaml`) khi một tag `v*` được tạo trên GitHub
(`.github/workflows/release.yml`). Có ba cách tạo tag, cùng một chuỗi job phía sau.

## Cách thường dùng: nhánh `release`

Mỗi lần nhánh `release` được cập nhật, workflow tự tính phiên bản, tạo tag trên commit đó, dựng và công bố.

1. `main` xanh CI, đã có mọi thay đổi cần phát hành.
2. Đưa `main` vào `release`: mở PR `main` → `release` rồi merge, hoặc fast-forward:

   ```sh
   git fetch origin && git push origin origin/main:refs/heads/release
   ```

3. Phiên bản do `scripts/release/version.sh` tính từ file `VERSION` ở gốc repo và các tag `vX.Y.Z` đã có:
   - `VERSION` lớn hơn tag mới nhất: dùng đúng `VERSION`. Muốn tăng minor/major thì sửa `VERSION` (vd. `0.3.0`) trong
     PR trước khi merge vào `release`.
   - `VERSION` bằng hoặc nhỏ hơn tag mới nhất: lấy tag mới nhất rồi tăng patch. Phát hành patch không cần sửa gì.
4. Commit đã có tag `v*` thì lượt chạy bỏ qua (đẩy lại cùng commit không phát hành hai lần). Mỗi lúc chỉ một lượt phát
   hành chạy; GitHub giữ tối đa một lượt chờ, nên đẩy nhiều lần liên tiếp thì lượt chờ cũ bị thay bằng lượt mới nhất (đã
   gồm commit cũ).

Hai cách còn lại giữ nguyên:

- Actions → Release → Run workflow trên `main`, nhập `version` (x.y.z) và `notes` (tuỳ chọn): workflow tạo tag
  `v<version>` trên commit của `main`.
- Tạo tag theo semver rồi đẩy lên:

  ```sh
  git tag -a v0.2.0 -m "hive-worker 0.2.0" && git push origin v0.2.0
  ```

## Ghi chú phát hành (tiếng Anh)

Ghi chú hiện ở trang release và trong app khi báo có bản mới (trường `notes` của `latest.json`). Nguồn, cái nào có trước
dùng cái đó (`scripts/release/notes.sh`):

1. Ô `notes` của nút Run workflow.
2. Mục `## v<x.y.z>` trong `RELEASE_NOTES.md` ở gốc repo (viết tay, tuỳ chọn). Mục chỉ cần có trước khi merge vào
   `release`; đầu mục có thể ghi thêm ngày, vd. `## v0.3.0 - 2026-10-15`.
3. Tự sinh từ tiêu đề các PR đã merge giữa tag trước và tag mới, nhóm theo tiền tố conventional commit: `feat` vào
   Features, `fix` vào Fixes, còn lại vào Other. Bỏ `chore`, merge nhánh và PR chuyển nhánh (tiêu đề bắt đầu bằng
   Release, Merge, Sync). Vì vậy tiêu đề PR và commit viết tiếng Anh, dạng `feat(scope): …`.

Thân trang release gồm ghi chú, dòng Full Changelog so với tag liền trước và mục Contributors.

Kiểm tại máy: `scripts/release/test.sh` (dựng repo git giả để thử tính phiên bản và sinh ghi chú; CI cũng chạy), và
`scripts/release/notes.sh v0.2.13 v0.2.12` để xem ghi chú của một bản đã có.

## Các bước sau khi có tag

1. Workflow chạy test worker, kiểm khoá ký khớp khoá công khai trong repo, dựng 6 bản (linux, darwin, windows ×
   amd64, arm64) thành bản nháp, kiểm chữ ký và số phiên bản trong binary, tạo chứng thực nguồn gốc.
2. Job `desktop` (`.github/workflows/desktop.yml`) đóng gói app desktop cho macOS arm64, Windows x64, Linux amd64 với
   cùng phiên bản (sidecar `hive-worker` bên trong mang đúng số đó) rồi gắn vào bản nháp.
3. Job `publish` chỉ công bố khi cả worker lẫn app đã đủ trong bản nháp. Bản nháp không bao giờ hiện ở
   `/releases/latest`, nên lỗi giữa chừng không làm máy nào cài nhầm. App lỗi đóng gói thì cả bản phát hành dừng lại.

Tên file nén không có số phiên bản (`hive-worker_linux_amd64.tar.gz`) để link `/releases/latest/download/...` luôn trỏ
tới bản mới nhất. `install.sh`, `install.ps1` và `worker/internal/update` dựa vào tên này; đổi `name_template` thì sửa
cả ba.

## Khoá ký

`checksums.txt` được ký bằng ECDSA P-256 (chữ ký DER, file `checksums.txt.sig`). Khoá bí mật chỉ nằm trong secret
`WORKER_SIGNING_KEY` của repo; khoá công khai nằm trong `worker/internal/update/release-signing.pem` và chép nguyên vào
`scripts/install.sh`, `scripts/install.ps1` (test Go kiểm ba chỗ giống nhau).

Đổi khoá (lộ khoá hoặc mất secret):

```sh
openssl ecparam -name prime256v1 -genkey -noout -out release-signing.key
openssl ec -in release-signing.key -pubout -out worker/internal/update/release-signing.pem
gh secret set WORKER_SIGNING_KEY < release-signing.key && rm release-signing.key
```

Rồi chép khoá công khai mới vào hai script cài và phát hành bản mới. Worker đang chạy chỉ tin khoá cũ, nên sau khi đổi
khoá, `hive-worker update` của chúng sẽ từ chối bản mới: cài lại bằng script cài trên từng máy.

## App desktop

File cài gắn vào cùng release, tên cố định để link `/releases/latest/download/<tên>` luôn trỏ tới bản mới nhất:

| Hệ điều hành | File |
|---|---|
| macOS (Apple Silicon) | `xdev-hive-desktop_macos_arm64.dmg` |
| Windows x64 | `xdev-hive-desktop_windows_x64-setup.exe`, `xdev-hive-desktop_windows_x64.msi` |
| Linux amd64 | `xdev-hive-desktop_linux_amd64.deb`, `.AppImage`, `.rpm` |

Mỗi nền tảng kèm `<tên>.sha256` và có chứng thực nguồn gốc (`gh attestation verify <file> --repo tdduydev/xdev-hive`).
Mac Intel chưa có bản dựng.

Đẩy lên `main` mà đổi `apps/desktop`, `worker` hay token màu thì workflow `Desktop` cũng đóng gói bản thử (phiên bản
0.0.0), tải ở mục Artifacts của lượt chạy, giữ 14 ngày. Chạy tay: `gh workflow run desktop.yml`.

**Ký mã.** Chưa có chứng chỉ nên bản dựng chưa ký:

- macOS báo "không xác minh được nhà phát triển". Mở bằng chuột phải, chọn Open, hoặc chạy
  `xattr -dr com.apple.quarantine "/Applications/xDev Hive.app"`. Khi có tài khoản Apple Developer, đặt các secret
  `APPLE_CERTIFICATE` (p12 dạng base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`; workflow tự ký và notarize khi có.
- Windows hiện cảnh báo SmartScreen ("More info" → "Run anyway") cho tới khi có chứng chỉ ký mã.

Cập nhật tự động của app (Tauri updater) chưa bật: xem mục "Cập nhật tự động" trong `apps/desktop/README.md`.

## Ký app macOS

App macOS được ký bằng chứng chỉ tự ký "xDev Hive Code Signing" (secret `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`). Chưa có `APPLE_ID`, nên bản build không được notarize: lần cài đầu
tiên macOS vẫn cảnh báo app không rõ nhà phát triển. Ký bằng một chứng chỉ cố định làm yêu cầu nhận diện của app ổn định
qua các bản, nên keychain chỉ hỏi mật khẩu một lần chứ không hỏi lại sau mỗi lần cập nhật. Workflow `desktop.yml` tin
chứng chỉ này trên runner rồi kiểm app ra không còn ký ad-hoc. Đổi chứng chỉ (hết hạn sau 10 năm, hoặc chuyển sang chứng
chỉ Apple Developer) thì người dùng phải cho phép keychain thêm một lần.
