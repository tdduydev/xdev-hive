# xDev Hive desktop

App Tauri 2: biểu tượng trên khay hệ thống, worker Go (`hive-worker`) chạy nền làm sidecar, cửa sổ web trỏ tới hub
mà máy đã đăng ký, và giao diện cục bộ của app (`src/`, React theo
[ADR 0016](../../docs/adr/0016-desktop-local-ui.md) và [specs/008-desktop-v2](../../specs/008-desktop-v2/)). App không
chứa giao diện web của hub.

## Chạy tại máy

Cần Node 24+, pnpm, Go và Rust.

```sh
pnpm --filter @xdev-hive/desktop app:dev
```

`tauri dev` và `tauri build` tự chạy `pnpm prepare:app`. Lệnh này dựng giao diện vào `dist/` bằng Vite và dựng
`hive-worker` vào `src-tauri/binaries/hive-worker-<target triple>`. Cả hai thư mục không commit.

Giao diện là React 19 + Vite + Tailwind 4 với component shadcn/ui (base-nova) chép vào `src/components/ui`, như web.
Màu và bo góc sinh vào `src/generated/tokens.css` từ `docs/design-system/tokens.json` khi build; logo lấy thẳng từ
`docs/design-system/assets/logos`. Chữ song ngữ VI/EN theo `src/lib/i18n.ts`, sáng/tối theo `src/lib/theme.ts`.

Xem giao diện trong trình duyệt, không cần Rust: `pnpm --filter @xdev-hive/desktop dev:ui`, rồi mở địa chỉ Vite in ra
(thêm `?window=app` để xem cửa sổ app). Lệnh gọi Rust sẽ báo lỗi vì không có Tauri. Test giao diện chạy bằng Vitest
và jsdom (`pnpm --filter @xdev-hive/desktop test`), giả `window.__TAURI__`.

Thử với cấu hình worker riêng, không đụng cấu hình thật của máy:

```sh
HIVE_WORKER_CONFIG=/tmp/hive-test/worker.json pnpm --filter @xdev-hive/desktop app:dev
```

## Cách app làm việc

- **Khởi động:** app gọi `hive-worker config --json`.
  - Máy đã đăng ký: app chạy `hive-worker run --status-json --stdin-control` và mở cửa sổ app cục bộ (AppNav, spec 008
    US1). Web của hub chỉ mở khi người dùng chọn: khay → Mở xDev Hive, hoặc liên kết tới một trang của hub.
  - Máy chưa đăng ký: app mở cửa sổ đăng ký.
- **Đăng nhập bằng trình duyệt (DESK-11):** nhập địa chỉ hub rồi bấm Đăng nhập bằng trình duyệt. App (lệnh
  `browser_login`, `src-tauri/src/browser_login.rs`) mở cổng tạm trên `127.0.0.1`, mở trang `/desktop/connect` của
  hub kèm PKCE (S256) và `state`; người dùng đăng nhập như trên web (email/mật khẩu, GitHub, SSO), chọn đội, bấm Cho
  phép. Trình duyệt quay về `127.0.0.1` với mã đổi dùng một lần (5 phút); app đổi mã kèm verifier ở
  `POST /api/v1/desktop/connect/exchange` lấy mã đăng ký máy và token cá nhân (90 ngày), rồi tự đăng ký máy và lưu
  token vào keychain. Token không nằm trên URL hay trong lịch sử trình duyệt; hub chỉ giữ băm của mã. Người đăng nhập
  phải được đăng ký máy cho đội (quản trị đội hoặc vai trò có `machines.register`), như khi tạo mã trên web.
- **Đăng ký bằng token:** nhập địa chỉ hub và token, hoặc dán lệnh `hive-worker register --hub … --token …` lấy từ web. App tự
  tách lệnh, kể cả lệnh nhiều dòng của bash, PowerShell, cmd. Token truyền cho sidecar qua biến môi trường
  `HIVE_REGISTRATION_TOKEN`, không qua tham số dòng lệnh.
- **Khay hệ thống:** dòng trạng thái của worker, Mở xDev Hive (web của hub), Mở app trên máy (cửa sổ `app` cục bộ
  với AppNav), Bật/Tắt worker, Thoát; chữ theo VI/EN của app (lệnh `set_lang`). Biểu tượng khay có chấm màu theo
  trạng thái (`src-tauri/src/tray_icon.rs`): xám khi tắt, vàng khi đang chuyển, xanh khi nhận việc, đỏ khi mất kết
  nối hoặc lỗi; vì chấm cần màu nên macOS cũng dùng biểu tượng màu thay cho ảnh template. Cửa sổ app nhận trạng thái
  qua sự kiện `worker-state` (thẻ worker ở AppNav). Đóng cửa sổ chỉ ẩn vào khay; worker vẫn chạy.
- **Trạng thái:** worker in mỗi trạng thái kết nối thành một dòng JSON trên stdout (`connecting`, `online`,
  `disconnected`, `stopped`). Máy trạng thái ở `src-tauri/src/worker.rs`:
  - Mất kết nối quá 1 phút thì có thông báo hệ thống, mỗi lần mất chỉ báo một lần.
  - Worker thoát bất thường thì chạy lại, chờ từ 5 giây tăng dần tới 5 phút.
  - Hub từ chối máy (mã thoát 3) thì không chạy lại; app mở cửa sổ đăng ký.
- **Dừng:** app gửi dòng `stop` qua stdin; Windows không có SIGTERM nên dùng cách này cho mọi hệ điều hành. Worker chờ
  run đang chạy ghi xong kết quả, tối đa 30 giây; quá 35 giây thì app giết tiến trình. App chết đột ngột thì stdin
  đóng và worker cũng tự dừng, không chạy mồ côi.
- **Màn Môi trường** (`src-tauri/src/doctor.rs`): dò công cụ bằng `--version` với PATH của shell đăng nhập (app mở
  từ Finder chỉ có PATH tối thiểu) và yêu cầu trong go.mod, .nvmrc, package.json của thư mục dự án. `run_install` chỉ
  nhận id của mục, Rust tự sinh lại lệnh; lệnh cần quyền quản trị hoặc cần shell chỉ để chép.
- **Màn Token và ngữ cảnh** (`src-tauri/src/usage.rs`): `claude -p "/context"` và `claude -p "/usage"` (lệnh cục bộ,
  không gọi model), cộng `usage` trong `~/.claude/projects/*/*.jsonl` và `token_count`, `rate_limits` trong
  `~/.codex/sessions/**/*.jsonl` của 7 ngày gần nhất. Chỉ đọc, không gửi ra ngoài máy.
- **Màn Tài liệu** (`src-tauri/src/cli.rs`): chạy Claude Code (`-p --output-format stream-json --verbose --restricted
  --strict-mcp-config --tools Read,Glob,Grep --permission-prompts none`) hoặc Codex (`exec --json --sandbox read-only
  --ignore-user-config`) trong thư mục dự án, không nhận thư mục gốc hay thư mục nhà. Agent chỉ đọc code; lời nhắc đi
  qua stdin; sự kiện `cli:event` chỉ gửi cho cửa sổ `app`. Môi trường của CLI dựng từ danh sách cho phép (không biến
  `HIVE_*`, token, khoá API hay biến của phiên agent khác). Đề xuất của agent vào bản nháp trong app; bản nháp lên hub
  bằng `propose_doc` (tool `doc_propose`, token cá nhân), người duyệt quyết.
- **Màn Máy chủ SSH** (`src-tauri/src/ssh_keys.rs`, `worker/internal/sshkeys`, [specs/023](../../specs/023-desktop-ssh-keys/spec.md)):
  chuyển đăng nhập SSH từ mật khẩu sang khoá qua `hive-worker ssh`. Khoá của máy là `~/.ssh/id_ed25519` (chưa có thì
  tạo, ed25519, không passphrase). Thêm máy chủ: app đọc khoá máy chủ, người dùng đối chiếu dấu vân tay với người quản
  trị, gõ mật khẩu một lần; sidecar chỉ gửi mật khẩu tới máy chủ có đúng dấu vân tay đó, một lần, rồi chép khoá công
  khai vào `~/.ssh/authorized_keys` (700/600, không thêm trùng), ghi `known_hosts` và khối `Host` giữa hai dòng
  `# >>> xdev-hive` trong `~/.ssh/config` (có sao lưu), rồi kiểm tra bằng `ssh -o BatchMode=yes` của máy. Mật khẩu chỉ
  đi qua stdin của sidecar, không lưu, không ghi log. App không tự tắt đăng nhập bằng mật khẩu trên máy chủ, chỉ hiện
  hướng dẫn sau cảnh báo.
- **Bảo mật:** lệnh của app (`parse_registration`, `register_worker`, `browser_login`) khai báo trong `build.rs`. Capability chỉ cấp
  các lệnh này cho cửa sổ `register` (`capabilities/default.json`). Cửa sổ `app` có capability riêng
  (`capabilities/app.json`), hiện chỉ `core:default`; màn nào cần lệnh Rust thì thêm đúng lệnh đó. Cửa sổ web của hub
  là trang từ xa, không có capability nào, nên không gọi được lệnh của app. CSP không cho script inline, nên sáng/tối
  đặt trong `src/main.tsx` trước lần vẽ đầu.

## Giao diện và prompt của Terminal

Thanh trên của Terminal có ô **Giao diện terminal**: Luôn tối (mặc định), Luôn sáng, Theo app. Lựa chọn và cỡ chữ lưu
theo máy.

Prompt nhiều màu, nhiều biểu tượng kiểu [Oh My Zsh](https://ohmyz.sh/) do shell vẽ, không phải app. Terminal của app chạy
`powershell.exe` trên Windows và shell đăng nhập (`$SHELL -l`, mặc định zsh) trên macOS, nên cài cho shell đó là thấy
trong app. Theme có biểu tượng cần một Nerd Font: font của terminal là JetBrains Mono, rồi tới `Symbols Nerd Font Mono`,
`JetBrainsMono Nerd Font Mono`, `MesloLGS NF` cho các ký tự JetBrains Mono không có. Cài font xong thì mở lại app.

**Windows: Oh My Posh** (Oh My Zsh chỉ chạy với zsh)

```powershell
winget install JanDeDobbeleer.OhMyPosh -s winget
oh-my-posh font install JetBrainsMono
```

Rồi trong một tab Shell của app, mở profile của Windows PowerShell bằng `notepad $PROFILE` (tạo file nếu chưa có) và thêm
dòng `oh-my-posh init pwsh | Invoke-Expression`. Đổi theme bằng `--config`, xem danh sách theme ở trang của Oh My Posh.
Máy chặn chạy profile thì đó là chính sách thực thi script của Windows: người dùng tự quyết có đổi hay không.

**macOS: Oh My Zsh**

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
brew install --cask font-jetbrains-mono-nerd-font
```

Theme đặt bằng `ZSH_THEME` trong `~/.zshrc`. `robbyrussell` (mặc định) không cần Nerd Font; `agnoster` cần.

## Phát hành

Tag `v*` (tự tạo mỗi lần nhánh `release` được cập nhật, xem `docs/releasing.md`) đóng gói app cho macOS arm64, Windows x64, Linux amd64 và gắn vào GitHub Release cùng worker; mỗi lần đổi
app trên `main` có bản thử ở mục Artifacts của workflow `Desktop`. Chi tiết, tên file và ký mã: `docs/releasing.md`.

**Phát hành bằng nút trên GitHub:** Actions → Release → Run workflow (chọn nhánh `main`), nhập `version` dạng `x.y.z`
(không có chữ `v`, tag chưa tồn tại) và `notes` (markdown, tuỳ chọn). Workflow tạo tag `v<version>` trên commit của `main`,
dựng worker và app, rồi công bố bản phát hành: thân bài gồm ghi chú, dòng Full Changelog so với tag liền trước và mục
Contributors. Đẩy tag `v*` bằng tay vẫn chạy như cũ.

## Cập nhật tự động

App kiểm bản mới lúc mở, 30 phút một lần và khi cửa sổ app được focus (cách lần kiểm trước ít nhất 5 phút), tải bản ký
đúng khoá công khai trong `plugins.updater.pubkey` của `tauri.conf.json` rồi hiện dòng "Đã tải bản X. Mở lại để cập nhật"
ở đầu cửa sổ (cùng mục trong khay). App không tự thoát vì máy có thể đang có run chạy: bản mới được cài khi người dùng
bấm Mở lại (worker dừng êm trước) hoặc thoát app. Worker đi kèm app không tự cập nhật (app thay cả gói).

- Thứ tự hỏi: hub của máy (nếu đã đăng ký), rồi GitHub
  `https://github.com/tdduydev/xdev-hive/releases/latest/download/latest.json`. Máy chưa đăng ký chỉ hỏi GitHub. Fork đổi
  địa chỉ GitHub bằng biến môi trường `HIVE_UPDATE_ENDPOINT`, đặt lúc chạy hoặc lúc build.
- Lệnh cho giao diện: `update_status`, `check_updates_now`, `relaunch_to_update`; sự kiện `update-ready` `{version, notes}`.

- Khoá riêng nằm ở secret `TAURI_SIGNING_PRIVATE_KEY` (và `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) của repo. Workflow
  `Desktop` chỉ dựng gói cập nhật (`.app.tar.gz`, AppImage, `-setup.exe` kèm `.sig`) khi có secret này.
- Tag `v*` (đẩy tay hoặc do nút Release tạo): `release.yml` ghép chữ ký thành `latest.json` (static JSON của Tauri updater, platform `darwin-aarch64`,
  `linux-x86_64`, `windows-x86_64`) và gắn vào bản phát hành.
- Hub đọc `latest.json` của bản phát hành mới nhất trên GitHub (đổi bằng `HIVE_DESKTOP_RELEASES`, `off` để tắt; đọc lại
  tối đa mỗi 5 phút) và trả cho app tại `/api/v1/desktop/updates/<os>/<arch>/<phiên bản hiện tại>`. App lấy địa chỉ hub
  từ cấu hình của máy, nên không ghi `endpoints` trong `tauri.conf.json`.
- Đổi khoá thì app đã cài không nhận bản ký bằng khoá mới: người dùng phải cài lại bằng file cài.
