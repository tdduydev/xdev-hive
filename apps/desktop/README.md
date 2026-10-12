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
  - Máy đã đăng ký: app chạy `hive-worker run --status-json --stdin-control` và mở cửa sổ web của hub.
  - Máy chưa đăng ký: app mở cửa sổ đăng ký.
- **Đăng ký:** nhập địa chỉ hub và token, hoặc dán lệnh `hive-worker register --hub … --token …` lấy từ web. App tự
  tách lệnh, kể cả lệnh nhiều dòng của bash, PowerShell, cmd. Token truyền cho sidecar qua biến môi trường
  `HIVE_REGISTRATION_TOKEN`, không qua tham số dòng lệnh.
- **Khay hệ thống:** dòng trạng thái của worker, Mở xDev Hive (web của hub), Mở app trên máy (cửa sổ `app` cục bộ
  với AppNav), Bật/Tắt worker, Thoát. Đóng cửa sổ chỉ ẩn vào khay; worker vẫn chạy.
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
- **Bảo mật:** lệnh của app (`parse_registration`, `register_worker`) khai báo trong `build.rs`. Capability chỉ cấp
  các lệnh này cho cửa sổ `register` (`capabilities/default.json`). Cửa sổ `app` có capability riêng
  (`capabilities/app.json`), hiện chỉ `core:default`; màn nào cần lệnh Rust thì thêm đúng lệnh đó. Cửa sổ web của hub
  là trang từ xa, không có capability nào, nên không gọi được lệnh của app. CSP không cho script inline, nên sáng/tối
  đặt trong `src/main.tsx` trước lần vẽ đầu.

## Cập nhật tự động

`tauri-plugin-updater` đã cài, nhưng `pubkey` trong `tauri.conf.json` đang để trống. Khi `pubkey` trống, app không
kiểm bản mới. Để bật:

1. Tạo cặp khoá: `pnpm --filter @xdev-hive/desktop tauri signer generate -w ~/.tauri/xdev-hive.key`. Giữ khoá riêng
   ngoài repo, ví dụ trong secret của CI.
2. Ghi khoá công khai vào `plugins.updater.pubkey` và đặt `bundle.createUpdaterArtifacts: true` trong
   `tauri.conf.json`.
3. Dựng bản phát hành với `TAURI_SIGNING_PRIVATE_KEY`. Đặt `HIVE_WORKER_VERSION` để sidecar mang đúng phiên bản.
4. Hub trả file JSON cập nhật của Tauri tại `/api/v1/desktop/updates/<os>/<arch>/<phiên bản hiện tại>`. App lấy địa
   chỉ hub từ cấu hình của máy, nên không cần ghi `endpoints` trong `tauri.conf.json`. Cấu hình `HIVE_DESKTOP_RELEASES`
   ở hub là đường dẫn file JSON hoặc URL HTTPS tới manifest phát hành; hub đọc lại tối đa mỗi 5 phút. Định dạng
   manifest theo static JSON của Tauri updater, với platform như `darwin-aarch64`, `linux-x86_64` hoặc `windows-x86_64`.
